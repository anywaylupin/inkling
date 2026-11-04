import { describe, expect, it } from "vitest";
import { mistral } from "../src/providers/mistral";
import { neon } from "../src/providers/neon";
import mistralModels from "./fixtures/mistral-models.json";
import endpoints from "./fixtures/neon-endpoints.json";
import projects from "./fixtures/neon-projects.json";
import { mockFetch, routes, testEnv } from "./helpers";

describe("neon", () => {
  it("finds the project by name and reports its compute state", async () => {
    const calls = mockFetch(routes({ "/endpoints": endpoints, "/projects": projects }));
    expect(await neon.check("project-a", { ...testEnv, NEON_API_KEY: "test-neon" })).toEqual({
      status: "Up",
      deployState: "Compute idle",
      url: "https://console.neon.tech/app/projects/wispy-lake-123456",
    });
    expect(calls[0]?.url).toContain("search=project-a");
    expect(calls[1]?.url).toContain("/projects/wispy-lake-123456/endpoints");
  });

  it("is Unknown when no project matches", async () => {
    mockFetch(routes({ "/projects": { projects: [] } }));
    expect((await neon.check("missing", { ...testEnv, NEON_API_KEY: "test-neon" })).status).toBe(
      "Unknown",
    );
  });
});

describe("mistral", () => {
  it("is Up when the key lists models", async () => {
    const calls = mockFetch(routes({ "/v1/models": mistralModels }));
    expect(
      await mistral.check("project-a", { ...testEnv, MISTRAL_API_KEY: "test-mistral" }),
    ).toEqual({
      status: "Up",
      deployState: "API key valid",
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer test-mistral");
  });

  it("links to the console when the key is missing", async () => {
    expect(await mistral.check("project-a", testEnv)).toEqual({
      status: "Unknown",
      error: "MISTRAL_API_KEY is not set.",
      errorLink: "https://console.mistral.ai/api-keys",
    });
  });
});
