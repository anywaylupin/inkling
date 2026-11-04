import type { Env } from "../env";
import { getJson, missingSecret, type Check, type Provider } from "./types";

const PAGES_PREFIX = "pages:";

interface WorkerDeployments {
  result: { deployments: { created_on: string; source: string }[] };
}

interface PagesDeployments {
  result: {
    id: string;
    created_on: string;
    url: string;
    latest_stage: { name: string; status: string };
  }[];
}

/** The Pages project name, or undefined for a Worker. */
function pagesProject(resourceId: string): string | undefined {
  return resourceId.startsWith(PAGES_PREFIX) ? resourceId.slice(PAGES_PREFIX.length) : undefined;
}

/** The dashboard page listing the Worker's or Pages project's deployments. */
function dashboard(resourceId: string, env: Env): string {
  if (!env.CF_ACCOUNT_ID) return "https://dash.cloudflare.com";
  const base = `https://dash.cloudflare.com/${env.CF_ACCOUNT_ID}`;
  const project = pagesProject(resourceId);
  return project
    ? `${base}/pages/view/${encodeURIComponent(project)}`
    : `${base}/workers/services/view/${encodeURIComponent(resourceId)}/production/deployments`;
}

/** Pages reports a stage per build step; only the last one says whether the deploy landed. */
function pagesCheck({ result }: PagesDeployments, listUrl: string): Check {
  const deployment = result[0];
  if (!deployment) return { status: "Unknown", error: "No production deployments" };
  const { name, status } = deployment.latest_stage;
  return {
    status: status === "success" ? "Up" : status === "failure" ? "Down" : "Degraded",
    lastDeploy: deployment.created_on,
    deployState: `${name} ${status}`,
    deployment: `${listUrl}/${deployment.id}`,
  };
}

/**
 * Reads a Worker script name, or a Pages project name written as `pages:<project>`.
 *
 * A prefix was chosen over trying both APIs because a guess costs an extra subrequest on every run.
 * A Worker's Domain needs the account's workers.dev subdomain, which costs a second call.
 */
export const cloudflare: Provider = {
  id: "cloudflare",
  cost: 2,
  link: dashboard,
  domain(resourceId, env) {
    const project = pagesProject(resourceId);
    return project ? `https://${project}.pages.dev` : dashboard(resourceId, env);
  },
  async check(resourceId, env) {
    if (!env.CF_API_TOKEN) return missingSecret("CF_API_TOKEN");
    if (!env.CF_ACCOUNT_ID) return missingSecret("CF_ACCOUNT_ID");
    const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}`;
    const headers = { authorization: `Bearer ${env.CF_API_TOKEN}` };
    const project = pagesProject(resourceId);
    if (project) {
      return pagesCheck(
        await getJson<PagesDeployments>(
          `${base}/pages/projects/${encodeURIComponent(project)}/deployments?env=production&per_page=1`,
          headers,
        ),
        dashboard(resourceId, env),
      );
    }
    const script = encodeURIComponent(resourceId);
    const [{ result }, subdomain] = await Promise.all([
      getJson<WorkerDeployments>(`${base}/workers/scripts/${script}/deployments`, headers),
      getJson<{ result: { subdomain: string } }>(`${base}/workers/subdomain`, headers),
    ]);
    const latest = result.deployments[0];
    if (!latest) return { status: "Unknown", error: "No deployments" };
    return {
      status: "Up",
      lastDeploy: latest.created_on,
      deployState: `Deployed via ${latest.source}`,
      domain: `https://${resourceId}.${subdomain.result.subdomain}.workers.dev`,
    };
  },
};
