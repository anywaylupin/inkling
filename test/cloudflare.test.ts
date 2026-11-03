import { describe, expect, it } from "vitest";
import { cloudflare } from "../src/providers/cloudflare";
import pages from "./fixtures/cloudflare-pages-deployments.json";
import workers from "./fixtures/cloudflare-worker-deployments.json";
import { mockFetch, routes, testEnv } from "./helpers";

describe("cloudflare", () => {
  it("reads the latest Worker deployment", async () => {
    const calls = mockFetch(routes({ "/workers/scripts/api/deployments": workers }));
    expect(await cloudflare.check("api", testEnv)).toEqual({
      status: "Up",
      lastDeploy: "2026-10-31T14:02:11.123Z",
      deployState: "Deployed via wrangler",
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer test-cloudflare");
  });

  it("reads the latest Pages production deployment", async () => {
    mockFetch(routes({ "/pages/projects/site/deployments": pages }));
    expect(await cloudflare.check("pages:site", testEnv)).toEqual({
      status: "Up",
      lastDeploy: "2026-11-01T08:00:00Z",
      deployState: "deploy success",
    });
  });

  it("is Down when the Pages deploy failed", async () => {
    const failed = {
      result: [{ ...pages.result[0], latest_stage: { name: "build", status: "failure" } }],
    };
    mockFetch(routes({ "/deployments": failed }));
    expect((await cloudflare.check("pages:site", testEnv)).status).toBe("Down");
  });

  it("is Unknown without the account id", async () => {
    const result = await cloudflare.check("api", { ...testEnv, CF_ACCOUNT_ID: undefined });
    expect(result).toEqual({ status: "Unknown", error: "CF_ACCOUNT_ID is not set" });
  });
});
