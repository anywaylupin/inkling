import { getJson, missingSecret, type Check, type Provider } from "./types";

const PAGES_PREFIX = "pages:";

interface WorkerDeployments {
  result: { deployments: { created_on: string; source: string }[] };
}

interface PagesDeployments {
  result: { created_on: string; latest_stage: { name: string; status: string } }[];
}

/** Pages reports a stage per build step; only the last one says whether the deploy landed. */
function pagesCheck({ result }: PagesDeployments): Check {
  const deployment = result[0];
  if (!deployment) return { status: "Unknown", error: "No production deployments" };
  const { name, status } = deployment.latest_stage;
  return {
    status: status === "success" ? "Up" : status === "failure" ? "Down" : "Degraded",
    lastDeploy: deployment.created_on,
    deployState: `${name} ${status}`,
  };
}

/**
 * Reads a Worker script name, or a Pages project name written as `pages:<project>`.
 *
 * A prefix was chosen over trying both APIs because a guess costs an extra subrequest on every run.
 */
export const cloudflare: Provider = {
  id: "cloudflare",
  async check(resourceId, env) {
    if (!env.CF_API_TOKEN) return missingSecret("CF_API_TOKEN");
    if (!env.CF_ACCOUNT_ID) return missingSecret("CF_ACCOUNT_ID");
    const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}`;
    const headers = { authorization: `Bearer ${env.CF_API_TOKEN}` };
    if (resourceId.startsWith(PAGES_PREFIX)) {
      const project = encodeURIComponent(resourceId.slice(PAGES_PREFIX.length));
      return pagesCheck(
        await getJson<PagesDeployments>(
          `${base}/pages/projects/${project}/deployments?env=production&per_page=1`,
          headers,
        ),
      );
    }
    const script = encodeURIComponent(resourceId);
    const { result } = await getJson<WorkerDeployments>(
      `${base}/workers/scripts/${script}/deployments`,
      headers,
    );
    const latest = result.deployments[0];
    if (!latest) return { status: "Unknown", error: "No deployments" };
    return {
      status: "Up",
      lastDeploy: latest.created_on,
      deployState: `Deployed via ${latest.source}`,
    };
  },
};
