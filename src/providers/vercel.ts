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
  deployments: { created: number; url: string; state?: string; readyState?: string }[];
}

/** Reads a project id; only the latest production deployment counts. */
export const vercel: Provider = {
  id: "vercel",
  cost: 1,
  link: () => "https://vercel.com/dashboard",
  async check(projectId, env) {
    if (!env.VERCEL_TOKEN) return missingSecret("VERCEL_TOKEN");
    const query = new URLSearchParams({ projectId, target: "production", limit: "1" });
    const { deployments } = await getJson<Deployments>(
      `https://api.vercel.com/v6/deployments?${query}`,
      { authorization: `Bearer ${env.VERCEL_TOKEN}` },
    );
    const latest = deployments[0];
    if (!latest) return { status: "Unknown", error: "No production deployments" };
    const state = latest.state ?? latest.readyState ?? "UNKNOWN";
    return {
      status: STATES[state] ?? "Unknown",
      lastDeploy: new Date(latest.created).toISOString(),
      deployState: state,
      url: `https://${latest.url}`,
    };
  },
};
