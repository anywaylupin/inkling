import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleRefresh } from "../src/refresh";
import query from "./fixtures/notion-query.json";
import { mockFetch, testEnv } from "./helpers";

const PAGE_ID = "1f2e3d4c-5b6a-4789-8abc-def012345678";

const env = { ...testEnv, REFRESH_SECRET: "test-refresh-secret" };

/** The http row from the query fixture as pages.retrieve returns it, under `dataSourceId`. */
function page(dataSourceId = "ds-1") {
  return {
    ...query.results[0],
    id: PAGE_ID,
    in_trash: false,
    parent: { type: "data_source_id", data_source_id: dataSourceId, database_id: "db-1" },
  };
}

/** A refresh request shaped like a Notion button webhook. */
function webhook(key = "test-refresh-secret") {
  return new Request("https://inkling.test/refresh", {
    method: "POST",
    headers: { "x-inkling-key": key, "content-type": "application/json" },
    body: JSON.stringify({ source: { type: "automation" }, data: { object: "page", id: PAGE_ID } }),
  });
}

describe("refresh", () => {
  it("checks the row, writes Last checked and answers before the check finishes", async () => {
    const calls = mockFetch((url, request) => {
      if (url.hostname === "example.com") return new Response("ok");
      if (request.method === "GET") return Response.json(page());
      return Response.json({ object: "page", id: PAGE_ID });
    });
    const ctx = createExecutionContext();
    const res = await handleRefresh(webhook(), env, ctx);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ refreshing: PAGE_ID, provider: "http" });
    await waitOnExecutionContext(ctx);

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain(`/v1/pages/${PAGE_ID}`);
    const body = await patch?.json<{ properties: Record<string, unknown> }>();
    expect(body?.properties).toMatchObject({
      Status: { status: { name: "Up" } },
      "Last checked": { date: {} },
    });
    const snapshots = await env.INKLING_STATE.get<Record<string, unknown>>("snapshot:http", "json");
    expect(snapshots?.[PAGE_ID]).toMatchObject({ status: "Up" });
  });

  it("accepts a plain page_id body", async () => {
    mockFetch((url) =>
      url.hostname === "api.notion.com" ? Response.json(page()) : new Response("ok"),
    );
    const request = new Request("https://inkling.test/refresh", {
      method: "POST",
      headers: { "x-inkling-key": "test-refresh-secret" },
      body: JSON.stringify({ page_id: PAGE_ID }),
    });
    const ctx = createExecutionContext();
    expect((await handleRefresh(request, env, ctx)).status).toBe(202);
    await waitOnExecutionContext(ctx);
  });

  it("reads Provider and Resource ID from formula columns", async () => {
    const formulas = {
      ...page(),
      properties: {
        ...page().properties,
        Provider: { id: "p", type: "formula", formula: { type: "string", string: "github" } },
        "Resource ID": {
          id: "r",
          type: "formula",
          formula: { type: "string", string: "acme/site" },
        },
      },
    };
    mockFetch(() => Response.json(formulas));
    const res = await handleRefresh(
      webhook(),
      { ...env, GITHUB_TOKEN: undefined },
      {
        ...createExecutionContext(),
        waitUntil: () => {},
      },
    );
    expect(await res.json()).toEqual({ refreshing: PAGE_ID, provider: "github" });
  });

  it("rejects a wrong key without calling Notion", async () => {
    const calls = mockFetch(() => new Response("unexpected", { status: 500 }));
    const res = await handleRefresh(webhook("wrong"), env, createExecutionContext());
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("is off when REFRESH_SECRET is not set", async () => {
    const res = await handleRefresh(webhook(), testEnv, createExecutionContext());
    expect(res.status).toBe(404);
  });

  it("refuses a page from another data source", async () => {
    mockFetch(() => Response.json(page("other-ds")));
    const res = await handleRefresh(webhook(), env, createExecutionContext());
    expect(res.status).toBe(404);
  });

  it("refuses a body without a page id", async () => {
    const request = new Request("https://inkling.test/refresh", {
      method: "POST",
      headers: { "x-inkling-key": "test-refresh-secret" },
      body: "not json",
    });
    expect((await handleRefresh(request, env, createExecutionContext())).status).toBe(400);
  });
});
