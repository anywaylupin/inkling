import { describe, expect, it } from "vitest";
import { vercel } from "../src/providers/vercel";
import fixture from "./fixtures/vercel-deployments.json";
import { mockFetch, routes, testEnv } from "./helpers";

/** The fixture with its one deployment in another state. */
function withState(state: string) {
  return { deployments: [{ ...fixture.deployments[0], state, readyState: state }] };
}

describe("vercel", () => {
  it("is Up when the latest production deployment is READY", async () => {
    const calls = mockFetch(routes({ "/v6/deployments": fixture }));
    expect(await vercel.check("prj_1", testEnv)).toEqual({
      status: "Up",
      lastDeploy: "2026-10-31T08:40:00.000Z",
      deployState: "READY",
      url: "https://project-a-abc123.vercel.app",
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("projectId")).toBe("prj_1");
    expect(url.searchParams.get("target")).toBe("production");
  });

  it.each([
    ["ERROR", "Down"],
    ["BUILDING", "Degraded"],
    ["CANCELED", "Unknown"],
  ])("maps %s to %s", async (state, status) => {
    mockFetch(routes({ "/v6/deployments": withState(state) }));
    expect((await vercel.check("prj_1", testEnv)).status).toBe(status);
  });

  it("is Unknown when there are no production deployments", async () => {
    mockFetch(routes({ "/v6/deployments": { deployments: [] } }));
    expect((await vercel.check("prj_1", testEnv)).status).toBe("Unknown");
  });

  it("is Unknown without a token", async () => {
    const result = await vercel.check("prj_1", { ...testEnv, VERCEL_TOKEN: undefined });
    expect(result).toMatchObject({ status: "Unknown", error: "VERCEL_TOKEN is not set." });
  });
});
