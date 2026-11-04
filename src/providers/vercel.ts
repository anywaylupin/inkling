import { getJson, missingSecret, type Provider, type Status } from "./types";

/** Queued and initializing builds read like BUILDING: a deploy is on its way but not live. */
const STATES: Record<string, Status> = {
  READY: "Up",
  ERROR: "Down",
  BUILDING: "Degraded",
  QUEUED: "Degraded",
  INITIALIZING: "Degraded",
};

interface Deployments {
  deployments: {
    created: number;
    url: string;
    inspectorUrl?: string;
    state?: string;
    readyState?: string;
  }[];
}

interface Project {
  name: string;
  targets?: { production?: { alias?: string[] } };
}

/**
 * Reads a project id or name; only the latest production deployment counts.
 *
 * Domain comes from the project's production aliases, with `<project>.vercel.app` as the fallback Vercel usually assigns.
 */
export const vercel: Provider = {
  id: "vercel",
  cost: 2,
  link: () => "https://vercel.com/dashboard",
  async check(projectId, env) {
    if (!env.VERCEL_TOKEN) return missingSecret("VERCEL_TOKEN");
    const headers = { authorization: `Bearer ${env.VERCEL_TOKEN}` };
    const query = new URLSearchParams({ projectId, target: "production", limit: "1" });
    const [{ deployments }, project] = await Promise.all([
      getJson<Deployments>(`https://api.vercel.com/v6/deployments?${query}`, headers),
      getJson<Project>(
        `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}`,
        headers,
      ),
    ]);
    const alias = project.targets?.production?.alias?.[0];
    const domain = `https://${alias ?? `${project.name}.vercel.app`}`;
    const latest = deployments[0];
    if (!latest) return { status: "Unknown", error: "No production deployments", domain };
    const state = latest.state ?? latest.readyState ?? "UNKNOWN";
    return {
      status: STATES[state] ?? "Unknown",
      lastDeploy: new Date(latest.created).toISOString(),
      deployState: state,
      deployment: latest.inspectorUrl ?? `https://${latest.url}`,
      domain,
    };
  },
};
