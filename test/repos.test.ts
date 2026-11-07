import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { syncRepos, type Repo } from "../src/repos";
import { handleSync } from "../src/sync";
import { mockFetch, testEnv } from "./helpers";

const env = {
  ...testEnv,
  REPOS_DATA_SOURCE_ID: "repos-ds",
  SYNC_SECRET: "test-sync-secret",
};

function repo(nameWithOwner: string, extra: Partial<Repo> = {}): Repo {
  const [owner = "", name = ""] = nameWithOwner.split("/");
  return {
    nameWithOwner,
    name,
    description: "A site",
    url: `https://github.com/${nameWithOwner}`,
    homepageUrl: "https://acme.dev",
    isPrivate: false,
    isArchived: false,
    isFork: false,
    owner: { login: owner, avatarUrl: `https://avatars.githubusercontent.com/u/1?v=4` },
    parent: null,
    stargazerCount: 7,
    forkCount: 1,
    primaryLanguage: { name: "TypeScript" },
    repositoryTopics: { nodes: [{ topic: { name: "notion" } }] },
    pullRequests: { totalCount: 1 },
    issues: { totalCount: 2 },
    defaultBranchRef: {
      name: "main",
      target: {
        committedDate: "2026-11-01T10:00:00Z",
        messageHeadline: "Fix build",
        url: "https://github.com/x/commit/1",
      },
    },
    latestRelease: {
      tagName: "v1.2.0",
      url: "https://github.com/x/r",
      publishedAt: "2026-10-01T00:00:00Z",
    },
    openGraphImageUrl: "https://opengraph.githubassets.com/1/x",
    ...extra,
  };
}

/** A Notion row as dataSources.query returns it. */
function row(id: string, dataSourceId: string, key: string, status: string) {
  return {
    object: "page",
    id,
    url: `https://www.notion.so/${id}`,
    in_trash: false,
    parent: { type: "data_source_id", data_source_id: dataSourceId, database_id: "db-1" },
    properties: {
      Key: { id: "k", type: "rich_text", rich_text: [{ plain_text: key }] },
      Status: { id: "s", type: "status", status: { name: status } },
    },
  };
}

const ROWS = {
  "repos-ds": [
    row("page-site", "repos-ds", "acme/site", "Shipped"),
    row("page-old", "repos-ds", "acme/old", "Shipped"),
  ],
};

/** Fakes GitHub GraphQL and Notion; `graphqlErrors` makes the first GitHub call fail like a rate limit. */
function fakeApis(graphqlErrors = false) {
  return mockFetch(async (url, request) => {
    if (url.hostname === "api.github.com" && url.pathname.startsWith("/repos/")) {
      return new Response(new Blob(["png"], { type: "image/png" }));
    }
    if (url.hostname === "api.github.com") {
      const { query } = await request.json<{ query: string }>();
      if (graphqlErrors) return Response.json({ errors: [{ type: "RATE_LIMITED" }] });
      if (query.includes("viewer")) {
        return Response.json({
          data: {
            viewer: {
              login: "acme",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  repo("acme/site", { i17: { id: "blob" } }),
                  repo("acme/new", { isPrivate: true, i0: { id: "blob" } }),
                ],
              },
            },
          },
        });
      }
      return Response.json({ data: { r0: null }, errors: [{ type: "NOT_FOUND" }] });
    }
    const source = /\/data_sources\/([^/]+)\/query/.exec(url.pathname)?.[1];
    if (source) {
      return Response.json({
        object: "list",
        results: ROWS[source as keyof typeof ROWS] ?? [],
        next_cursor: null,
        has_more: false,
      });
    }
    if (request.method === "GET") return Response.json(ROWS["repos-ds"][0]);
    return Response.json({ object: "page", id: "created" });
  });
}

async function writes(calls: Request[]) {
  const out: { method: string; path: string; body: Record<string, unknown> }[] = [];
  for (const call of calls) {
    const path = new URL(call.url).pathname;
    if (!path.startsWith("/v1/pages")) continue;
    if (call.method !== "POST" && call.method !== "PATCH") continue;
    out.push({ method: call.method, path, body: await call.json() });
  }
  return out;
}

describe("syncRepos", () => {
  it("creates new repos, updates changed ones and deprecates gone ones", async () => {
    const calls = fakeApis();
    await syncRepos(env, new Date("2026-11-05T00:00:00Z"));
    const all = await writes(calls);

    const created = all.filter((w) => w.method === "POST");
    expect(created).toHaveLength(1);
    expect(created[0]?.body["properties"]).toMatchObject({
      Name: { title: [{ text: { content: "new" } }] },
      Origin: { select: { name: "Own" } },
      Status: { status: { name: "Planned" } },
      Visibility: { select: { name: "Private" } },
    });

    const update = (id: string) =>
      all.find((w) => w.method === "PATCH" && w.path.endsWith(id))?.body["properties"];
    expect(update("page-site")).toMatchObject({
      Stars: { number: 7 },
      Topics: { multi_select: [{ name: "notion" }] },
      "Commit message": {
        rich_text: [
          { text: { content: "Fix build", link: { url: "https://github.com/x/commit/1" } } },
        ],
      },
      "Last synced": { date: { start: "2026-11-05T00:00:00.000Z" } },
    });
    expect(update("page-old")).toEqual({ Status: { status: { name: "Deprecated" } } });

    // Private repo: its icon file, downloaded with the token and uploaded to Notion. Public repo: a raw link.
    expect(created[0]?.body["icon"]).toEqual({
      type: "file_upload",
      file_upload: { id: "created" },
    });
    const download = calls.find((c) => c.url.includes("/repos/acme/new/contents/"));
    expect(download?.url).toBe("https://api.github.com/repos/acme/new/contents/app/apple-icon.png");
    expect(calls.some((c) => c.url.endsWith("/v1/file_uploads/created/send"))).toBe(true);
    const create = calls.find((c) => c.url.endsWith("/v1/file_uploads"));
    expect(await create?.json()).toMatchObject({
      filename: "apple-icon.png",
      content_type: "image/png",
    });
    const sitePatch = all.find((w) => w.method === "PATCH" && w.path.endsWith("page-site"));
    expect(sitePatch?.body["icon"]).toEqual({
      type: "external",
      external: { url: "https://raw.githubusercontent.com/acme/site/main/app/favicon.ico" },
    });
    // Public repo: its social preview. Private repo: no cover.
    expect(sitePatch?.body["cover"]).toEqual({
      type: "external",
      external: { url: "https://opengraph.githubassets.com/1/x" },
    });
    expect(created[0]?.body["cover"]).toBeNull();
  });

  it("keeps an icon you picked yourself", async () => {
    const [saved] = ROWS["repos-ds"];
    if (!saved) throw new Error("fixture missing");
    ROWS["repos-ds"][0] = { ...saved, icon: { type: "emoji", emoji: "🚀" } } as typeof saved;
    try {
      const calls = fakeApis();
      await syncRepos(env);
      const patch = (await writes(calls)).find((w) => w.path.endsWith("page-site"));
      expect(patch?.body["properties"]).toBeDefined();
      expect(patch?.body).not.toHaveProperty("icon");
    } finally {
      ROWS["repos-ds"][0] = saved;
    }
  });

  it("keeps Notion keys out of the query text", async () => {
    const calls = fakeApis();
    await syncRepos(env);
    const lookup = calls.filter((c) => c.url.includes("graphql")).at(-1);
    const body = await lookup?.json<{ query: string; variables: Record<string, unknown> }>();
    expect(body?.query).not.toContain("acme/old");
    expect(body?.variables).toEqual({ ro0: "acme", rn0: "old" });
  });

  it("skips unchanged repos on the next run, but restores a missing icon", async () => {
    fakeApis();
    await syncRepos(env);
    // The fake row has no icon yet, so the second run writes it even though nothing else changed.
    const again = fakeApis();
    await syncRepos(env);
    const restored = (await writes(again)).find((w) => w.path.endsWith("page-site"));
    expect(restored?.body["icon"]).toMatchObject({ type: "external" });

    const [saved] = ROWS["repos-ds"];
    if (!saved) throw new Error("fixture missing");
    ROWS["repos-ds"][0] = {
      ...saved,
      icon: restored?.body["icon"],
      cover: restored?.body["cover"],
    } as typeof saved;
    try {
      const calls = fakeApis();
      await syncRepos(env);
      const patched = (await writes(calls)).filter((w) => w.path.endsWith("page-site"));
      expect(patched).toHaveLength(0);
    } finally {
      ROWS["repos-ds"][0] = saved;
    }
  });

  it("writes nothing when GitHub answers with an error", async () => {
    const calls = fakeApis(true);
    await expect(syncRepos(env)).rejects.toThrow("RATE_LIMITED");
    expect(await writes(calls)).toHaveLength(0);
  });

  it("does nothing without REPOS_DATA_SOURCE_ID", async () => {
    const calls = fakeApis();
    await syncRepos({ ...env, REPOS_DATA_SOURCE_ID: undefined });
    expect(calls).toHaveLength(0);
  });
});

describe("sync route on a Repos row", () => {
  it("runs the repo sync", async () => {
    fakeApis();
    const ctx = createExecutionContext();
    const res = await handleSync(
      new Request("https://para.test/sync", {
        method: "POST",
        headers: { "x-para-key": "test-sync-secret" },
        body: JSON.stringify({ page_id: "1f2e3d4c-5b6a-4789-8abc-def012345678" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "repos" });
    await waitOnExecutionContext(ctx);
  });
});
