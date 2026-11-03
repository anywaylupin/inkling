import { describe, expect, it, vi } from "vitest";
import { nextProvider, run } from "../src/run";
import release from "./fixtures/github-release.json";
import repo from "./fixtures/github-repo.json";
import runs from "./fixtures/github-runs.json";
import query from "./fixtures/notion-query.json";
import { mockFetch, testEnv } from "./helpers";

/** Fakes Notion, GitHub, the http target and ntfy; `siteStatus` drives the http row. */
function world(siteStatus: () => number) {
  return mockFetch((url, request) => {
    if (url.hostname === "api.notion.com") {
      if (url.pathname.endsWith("/query")) return Response.json(query);
      return Response.json({ object: "page", id: url.pathname.split("/").at(-1) });
    }
    if (url.hostname === "example.com") return new Response(null, { status: siteStatus() });
    if (url.hostname === "ntfy.sh") return new Response("ok");
    if (url.pathname.endsWith("/actions/runs")) return Response.json(runs);
    if (url.pathname.endsWith("/releases/latest")) return Response.json(release);
    if (url.pathname.endsWith("/repos/acme/site")) return Response.json(repo);
    return new Response(`unexpected ${request.method} ${url}`, { status: 500 });
  });
}

/** Notion page updates among the recorded calls, with their parsed bodies. */
async function patches(calls: Request[]) {
  const updates = calls.filter((c) => c.method === "PATCH" && c.url.includes("/v1/pages/"));
  return Promise.all(
    updates.map(async (c) => ({
      page: c.url.split("/").at(-1),
      properties: (await c.json<{ properties: Record<string, unknown> }>()).properties,
    })),
  );
}

describe("nextProvider", () => {
  it("rotates through present providers in fixed order", () => {
    expect(nextProvider(["http", "github", "render"], null)).toBe("http");
    expect(nextProvider(["http", "github", "render"], "http")).toBe("github");
    expect(nextProvider(["http", "github", "render"], "cloudflare")).toBe("render");
    expect(nextProvider(["http", "github", "render"], "render")).toBe("http");
    expect(nextProvider([], "http")).toBeUndefined();
  });
});

describe("run", () => {
  it("checks one provider per run, writes only changes and alerts on status change", async () => {
    let code = 200;
    const t0 = new Date("2026-11-03T10:00:00Z");

    let calls = world(() => code);
    await run(testEnv, t0);
    let written = await patches(calls);
    expect(written).toHaveLength(1);
    expect(written[0]?.page).toBe("page-http");
    expect(written[0]?.properties).toMatchObject({
      Status: { select: { name: "Up" } },
      "Last checked": { date: { start: t0.toISOString() } },
    });
    expect(await testEnv.INKLING_STATE.get("cursor")).toBe("http");
    expect(calls.some((c) => c.url.includes("api.github.com"))).toBe(false);

    calls = world(() => code);
    await run(testEnv, t0);
    written = await patches(calls);
    expect(written.map((w) => w.page)).toEqual(["page-github"]);
    expect(await testEnv.INKLING_STATE.get("cursor")).toBe("github");

    calls = world(() => code);
    await run(testEnv, new Date(t0.getTime() + 30 * 60 * 1000));
    expect(await patches(calls)).toHaveLength(0);
    expect(calls.some((c) => c.url.includes("ntfy.sh"))).toBe(false);

    await testEnv.INKLING_STATE.put("cursor", "render");
    code = 503;
    calls = world(() => code);
    await run(testEnv, new Date(t0.getTime() + 45 * 60 * 1000));
    written = await patches(calls);
    expect(written).toHaveLength(1);
    expect(written[0]?.properties).toMatchObject({ Status: { select: { name: "Down" } } });
    expect(written[0]?.properties).not.toHaveProperty("Last checked");
    const alert = calls.find((c) => c.url.includes("ntfy.sh"));
    expect(await alert?.text()).toBe("Landing page is Down, was Up");
  });

  it("keeps going when a provider call fails and never logs the response", async () => {
    await testEnv.INKLING_STATE.put("cursor", "http");
    const calls = mockFetch((url) => {
      if (url.pathname.endsWith("/query")) return Response.json(query);
      if (url.hostname === "api.notion.com") return Response.json({ object: "page" });
      if (url.hostname === "ntfy.sh") return new Response("ok");
      return new Response('{"secret":"do-not-log"}', { status: 502 });
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await run(testEnv, new Date("2026-11-03T12:00:00Z"));
    expect(log.mock.calls).toEqual([["github check failed: HTTP 502"]]);
    const [written] = await patches(calls);
    expect(written?.properties).toMatchObject({
      Status: { select: { name: "Unknown" } },
      Error: { rich_text: [{ text: { content: "Check failed: HTTP 502" } }] },
    });
  });
});
