import { getJson, missingSecret, type Provider } from "./types";

const API = "https://api.render.com/v1";

interface Deploy {
  status: string;
  createdAt: string;
  finishedAt?: string | null;
}

/**
 * Reads a service id: a suspended service is Down, the latest deploy fills Deploy state.
 *
 * A failed deploy is Degraded rather than Down because Render keeps serving the previous one.
 */
export const render: Provider = {
  id: "render",
  async check(serviceId, env) {
    if (!env.RENDER_API_KEY) return missingSecret("RENDER_API_KEY");
    const id = encodeURIComponent(serviceId);
    const headers = { authorization: `Bearer ${env.RENDER_API_KEY}`, accept: "application/json" };
    const [service, deploys] = await Promise.all([
      getJson<{ suspended: string }>(`${API}/services/${id}`, headers),
      getJson<{ deploy: Deploy }[]>(`${API}/services/${id}/deploys?limit=1`, headers),
    ]);
    const deploy = deploys[0]?.deploy;
    const failed = deploy?.status.endsWith("failed") ?? false;
    return {
      status: service.suspended === "suspended" ? "Down" : failed ? "Degraded" : "Up",
      lastDeploy: deploy ? (deploy.finishedAt ?? deploy.createdAt) : undefined,
      deployState: deploy?.status,
    };
  },
};
