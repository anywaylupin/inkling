import { describe, expect, it } from "vitest";
import { github } from "../src/providers/github";
import release from "./fixtures/github-release.json";
import repo from "./fixtures/github-repo.json";
import runs from "./fixtures/github-runs.json";
import { mockFetch, routes, testEnv } from "./helpers";

describe("github", () => {
  it("reads the latest completed run on the default branch and the latest release", async () => {
    const calls = mockFetch(
      routes({ "/actions/runs": runs, "/releases/latest": release, "/repos/acme/site": repo }),
    );
    expect(await github.check("acme/site", testEnv)).toEqual({
      status: "Up",
      lastDeploy: "2026-10-30T09:12:00Z",
      deployState: "v1.2.0",
    });
    const runsUrl = new URL(calls.find((c) => c.url.includes("/actions/runs"))?.url ?? "");
    expect(runsUrl.searchParams.get("branch")).toBe("main");
    expect(runsUrl.searchParams.get("status")).toBe("completed");
  });

  it("is Down when the latest run failed and tolerates a repo without releases", async () => {
    const failed = { workflow_runs: [{ ...runs.workflow_runs[0], conclusion: "failure" }] };
    mockFetch(routes({ "/actions/runs": failed, "/repos/acme/site": repo }));
    expect(await github.check("acme/site", testEnv)).toEqual({ status: "Down" });
  });

  it("is Unknown without a token", async () => {
    const result = await github.check("acme/site", { ...testEnv, GITHUB_TOKEN: undefined });
    expect(result).toMatchObject({ status: "Unknown", error: "GITHUB_TOKEN is not set." });
  });

  it("rejects a Resource ID that is not owner/repo", async () => {
    expect((await github.check("https://github.com/acme/site", testEnv)).status).toBe("Unknown");
  });

  it("throws an error with only the status code when the repo is missing", async () => {
    mockFetch(() => new Response('{"message":"Not Found"}', { status: 404 }));
    await expect(github.check("acme/gone", testEnv)).rejects.toThrow("HTTP 404");
  });
});
