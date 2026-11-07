import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { PageObjectResponse } from "@notionhq/client";
import { describe, expect, it } from "vitest";
import { agentsOf, frontmatter, pluginManifest, syncSkills, targetOf } from "../src/skills";
import { handleSync } from "../src/sync";
import { mockFetch, testEnv } from "./helpers";

const env = { ...testEnv, SKILLS_DATA_SOURCE_ID: "skills-ds", SYNC_SECRET: "test-sync-secret" };

const rt = (value?: string) => ({
  type: "rich_text",
  rich_text: value ? [{ plain_text: value }] : [],
});

/** A Skills row as dataSources.query returns it. */
function row(id: string, fields: { source: string; slug?: string; kind?: string; icon?: unknown }) {
  return {
    object: "page",
    id,
    url: `https://www.notion.so/${id}`,
    in_trash: false,
    icon: fields.icon ?? null,
    parent: { type: "data_source_id", data_source_id: "skills-ds", database_id: "db-1" },
    properties: {
      Kind: { type: "select", select: { name: fields.kind ?? "Skill" } },
      Source: rt(fields.source),
      Slug: rt(fields.slug),
      Description: rt(),
      Version: rt(),
      Marketplace: rt(),
      GitHub: { type: "url", url: null as string | null },
      Domain: { type: "url", url: null as string | null },
      Agents: { type: "multi_select", multi_select: [] as { name: string }[] },
      Stars: { type: "number", number: null as number | null },
    },
  };
}

const SKILL_MD = `---
name: frontend-design
description: "Build distinctive interfaces"
---
# Frontend design`;

const PLUGIN_JSON = JSON.stringify({
  name: "ponytail",
  version: "5.3.3",
  description: "Lazy senior dev mode.",
});
const MARKETPLACE_JSON = JSON.stringify({ name: "ponytail-market", plugins: [] });

/** Fakes Notion and GitHub: s0 is a skill found in its second folder, s1 is gone, s2 is a plugin at the repo root. */
function fakeApis(rows: unknown[]) {
  return mockFetch(async (url, request) => {
    if (url.hostname === "api.github.com") {
      return Response.json({
        data: {
          s0: {
            url: "https://github.com/acme/agent-skills",
            homepageUrl: null,
            stargazerCount: 12,
            root: { entries: [{ name: "skills" }, { name: "README.md" }] },
            defaultBranchRef: { name: "main" },
            f0: null,
            f1: { text: SKILL_MD },
            f2: null,
          },
          s1: null,
          s2: {
            url: "https://github.com/acme/ponytail",
            homepageUrl: "https://ponytail.dev",
            stargazerCount: 7,
            root: {
              entries: [
                { name: ".claude-plugin" },
                { name: ".codex-plugin" },
                { name: "gemini-extension.json" },
                { name: "CLAUDE.md" },
              ],
            },
            defaultBranchRef: { name: "main" },
            f0: { text: PLUGIN_JSON },
            m: { text: MARKETPLACE_JSON },
          },
        },
        errors: [{ type: "NOT_FOUND" }],
      });
    }
    if (/\/data_sources\/[^/]+\/query/.test(url.pathname)) {
      return Response.json({ object: "list", results: rows, next_cursor: null, has_more: false });
    }
    if (request.method === "GET") return Response.json(rows[0]);
    return Response.json({ object: "page", id: "updated" });
  });
}

async function patches(calls: Request[]) {
  const out: { path: string; body: Record<string, unknown> }[] = [];
  for (const call of calls) {
    if (call.method !== "PATCH") continue;
    out.push({ path: new URL(call.url).pathname, body: await call.json() });
  }
  return out;
}

describe("targetOf", () => {
  const page = (source: string, slug?: string, kind?: string) =>
    row("p", { source, slug, kind }) as unknown as PageObjectResponse;

  it("reads owner/repo with a slug as candidate folders for a skill", () => {
    expect(targetOf(page("acme/agent-skills", "frontend-design"))).toMatchObject({
      kind: "Skill",
      owner: "acme",
      repo: "agent-skills",
      folders: ["skills/frontend-design", "frontend-design", ".claude/skills/frontend-design"],
    });
  });

  it("looks in plugins/<slug>, <slug> and the root for a plugin", () => {
    expect(targetOf(page("acme/tools", "lint", "Plugin"))?.folders).toEqual([
      "plugins/lint",
      "lint",
      "",
    ]);
  });

  it("reads a folder URL as that exact folder and branch", () => {
    expect(
      targetOf(page("https://github.com/acme/agent-skills/tree/dev/skills/pdf")),
    ).toMatchObject({
      owner: "acme",
      repo: "agent-skills",
      branch: "dev",
      folders: ["skills/pdf"],
    });
  });

  it("ignores other kinds and non-GitHub sources", () => {
    expect(targetOf(page("acme/x", undefined, "MCP server"))).toBeUndefined();
    expect(targetOf(page("https://gitlab.com/acme/x"))).toBeUndefined();
  });
});

describe("agentsOf", () => {
  it("maps root config files to agents, once each, sorted", () => {
    expect(
      agentsOf([".codex-plugin", "CLAUDE.md", ".claude-plugin", ".windsurf", "README.md"]),
    ).toEqual(["Claude Code", "Codex", "Windsurf"]);
    expect(agentsOf(["src", "package.json"])).toEqual([]);
  });
});

describe("manifests", () => {
  it("reads SKILL.md frontmatter, unquoted", () => {
    expect(frontmatter(SKILL_MD)).toEqual({
      name: "frontend-design",
      description: "Build distinctive interfaces",
      version: undefined,
    });
  });

  it("joins a folded (>) description and keeps a literal (|) one's lines", () => {
    const folded =
      "---\nname: ponytail\ndescription: >\n  Lazy senior dev mode:\n  the smallest change.\nlicense: MIT\n---\n";
    expect(frontmatter(folded)).toMatchObject({
      name: "ponytail",
      description: "Lazy senior dev mode: the smallest change.",
    });
    const literal = "---\ndescription: |-\n  line one\n  line two\n---\n";
    expect(frontmatter(literal).description).toBe("line one\nline two");
  });

  it("reads plugin.json, and treats a broken one as empty", () => {
    expect(pluginManifest(PLUGIN_JSON)).toEqual({
      name: "ponytail",
      description: "Lazy senior dev mode.",
      version: "5.3.3",
    });
    expect(pluginManifest("{oops")).toEqual({});
  });
});

describe("syncSkills", () => {
  it("fills skill and plugin rows from their manifests and repos", async () => {
    const calls = fakeApis([
      row("skill-1", { source: "acme/agent-skills", slug: "frontend-design" }),
      row("skill-2", { source: "acme/gone" }),
      row("plugin-1", { source: "acme/ponytail", kind: "Plugin" }),
      row("mcp-1", { source: "acme/agent-skills", kind: "MCP server" }),
    ]);
    await syncSkills(env);
    const written = await patches(calls);
    expect(written.map((w) => w.path)).toEqual(["/v1/pages/skill-1", "/v1/pages/plugin-1"]);

    // The page icon is never written.
    expect(written[0]?.body).not.toHaveProperty("icon");
    expect(written[0]?.body).toMatchObject({
      properties: {
        Description: { rich_text: [{ text: { content: "Build distinctive interfaces" } }] },
        GitHub: { url: "https://github.com/acme/agent-skills" },
        Stars: { number: 12 },
      },
    });
    // Slug was already set, so it is left alone.
    expect(written[0]?.body["properties"]).not.toHaveProperty("Slug");

    expect(written[1]?.body["properties"]).toMatchObject({
      Description: { rich_text: [{ text: { content: "Lazy senior dev mode." } }] },
      Version: { rich_text: [{ text: { content: "5.3.3" } }] },
      Slug: { rich_text: [{ text: { content: "ponytail" } }] },
      Marketplace: { rich_text: [{ text: { content: "ponytail-market" } }] },
      GitHub: { url: "https://github.com/acme/ponytail" },
      Domain: { url: "https://ponytail.dev" },
      Stars: { number: 7 },
      Agents: {
        multi_select: [{ name: "Claude Code" }, { name: "Codex" }, { name: "Gemini CLI" }],
      },
    });

    const query = calls.find((c) => c.url.includes("graphql"));
    const body = await query?.json<{ query: string; variables: Record<string, string> }>();
    expect(body?.query).not.toContain("acme");
    expect(body?.variables).toMatchObject({
      o0: "acme",
      n0: "agent-skills",
      e0_0: "HEAD:skills/frontend-design/SKILL.md",
      e2_0: "HEAD:.claude-plugin/plugin.json",
      m2: "HEAD:.claude-plugin/marketplace.json",
    });
  });

  it("writes nothing when every value already matches", async () => {
    const current = row("skill-1", {
      source: "acme/agent-skills",
      slug: "frontend-design",
      icon: { type: "emoji", emoji: "🎨" },
    });
    current.properties.Description = rt("Build distinctive interfaces");
    current.properties.GitHub.url = "https://github.com/acme/agent-skills";
    current.properties.Stars.number = 12;
    const calls = fakeApis([current]);
    await syncSkills(env);
    expect(await patches(calls)).toHaveLength(0);
  });

  it("does nothing without SKILLS_DATA_SOURCE_ID", async () => {
    const calls = fakeApis([]);
    await syncSkills({ ...env, SKILLS_DATA_SOURCE_ID: undefined });
    expect(calls).toHaveLength(0);
  });
});

describe("sync route on a Skills row", () => {
  it("runs the skills sync", async () => {
    fakeApis([row("1f2e3d4c-5b6a-4789-8abc-def012345678", { source: "acme/agent-skills" })]);
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
    expect(await res.json()).toMatchObject({ source: "skills" });
    await waitOnExecutionContext(ctx);
  });
});
