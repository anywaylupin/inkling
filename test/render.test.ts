import { describe, expect, it } from "vitest";
import { render } from "../src/providers/render";
import deploys from "./fixtures/render-deploys.json";
import service from "./fixtures/render-service.json";
import { mockFetch, routes, testEnv } from "./helpers";

describe("render", () => {
  it("is Up when the service runs and the latest deploy is live", async () => {
    mockFetch(routes({ "/deploys": deploys, "/services/srv-abc": service }));
    expect(await render.check("srv-abc", testEnv)).toEqual({
      status: "Up",
      lastDeploy: "2026-11-01T10:03:00Z",
      deployState: "live",
      url: "https://api.onrender.com",
    });
  });

  it("is Down when the service is suspended", async () => {
    mockFetch(
      routes({ "/deploys": deploys, "/services/srv-abc": { ...service, suspended: "suspended" } }),
    );
    expect((await render.check("srv-abc", testEnv)).status).toBe("Down");
  });

  it("is Degraded when the latest deploy failed", async () => {
    const failed = [{ ...deploys[0], deploy: { ...deploys[0]?.deploy, status: "build_failed" } }];
    mockFetch(routes({ "/deploys": failed, "/services/srv-abc": service }));
    expect(await render.check("srv-abc", testEnv)).toMatchObject({
      status: "Degraded",
      deployState: "build_failed",
    });
  });

  it("is Unknown without an API key", async () => {
    const result = await render.check("srv-abc", { ...testEnv, RENDER_API_KEY: undefined });
    expect(result).toEqual({ status: "Unknown", error: "RENDER_API_KEY is not set" });
  });
});
