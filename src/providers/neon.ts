import { getJson, missingSecret, type Provider } from "./types";

const API = "https://console.neon.tech/api/v2";

/**
 * Reads a Neon project id or name; the endpoint's compute state fills Deploy state.
 *
 * Idle computes count as Up because the Free plan suspends them after a few minutes and wakes them on the next query.
 */
export const neon: Provider = {
  id: "neon",
  cost: 2,
  link: () => "https://console.neon.tech/app/projects",
  async check(resourceId, env) {
    if (!env.NEON_API_KEY) return missingSecret("NEON_API_KEY");
    const headers = { authorization: `Bearer ${env.NEON_API_KEY}`, accept: "application/json" };
    const { projects } = await getJson<{ projects: { id: string; name: string }[] }>(
      `${API}/projects?search=${encodeURIComponent(resourceId)}`,
      headers,
    );
    const project = projects.find((p) => p.id === resourceId || p.name === resourceId);
    if (!project) return { status: "Unknown", error: `No Neon project named ${resourceId}` };
    const { endpoints } = await getJson<{ endpoints: { current_state: string }[] }>(
      `${API}/projects/${project.id}/endpoints`,
      headers,
    );
    const states = endpoints.map((e) => e.current_state);
    return {
      status: states.length > 0 ? "Up" : "Degraded",
      deployState: states.length > 0 ? `Compute ${states.join(", ")}` : "No compute endpoint",
      url: `https://console.neon.tech/app/projects/${project.id}`,
    };
  },
};
