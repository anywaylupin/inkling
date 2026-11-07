import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { PageObjectResponse } from "@notionhq/client";
import { describe, expect, it } from "vitest";
import { frontmatter, syncSkills, targetOf } from "../src/skills";
import { handleSync } from "../src/sync";
import { mockFetch, testEnv } from "./helpers";

const env = { ...testEnv, SKILLS_DATA_SOURCE_ID: "skills-ds", SYNC_SECRET: "test-sync-secret" };

/** A Skills row as dataSources.query returns it. */
function row(id: string, fields: { source: string; name?: string; type?: string; icon?: unknown }) {
  const rt = (value?: string) => ({
    type: "rich_text",
    rich_text: value ? [{ plain_text: value }] : [],
  });
  return {
    object: "page",
    id,
    url: `https://www.notion.so/${id}`,
    in_trash: false,
    icon: fields.icon ?? null,
    parent: { type: "data_source_id", data_source_id: "skills-ds", database_id: "db-1" },
    properties: {
      Type: { type: "select", select: { name: fields.type ?? "Skill" } },
      Source: rt(fields.source),
      "Skill name": rt(fields.name),
      Purpose: rt(),
      Website: { type: "url", url: null },
    },
  };
}

const SKILL_MD = `---
name: frontend-design
description: "Build distinctive interfaces"
---
# Frontend design`;

/** Fakes Notion and GitHub; `rows` are the Skills rows. */
function fakeApis(rows: unknown[]) {
  return mockFetch(async (url, request) => {
    if (url.hostname === "api.github.com") {
      const { variables } = await request.json<{ variables: Record<string, string> }>();
      // s0 finds SKILL.md in its second candidate folder; s1's repo is gone.
      return Response.json({
        data: {
          s0: {
            url: "https://github.com/acme/agent-skills",
            owner: { avatarUrl: "https://avatars.githubusercontent.com/u/9" },
            defaultBranchRef: { name: "main" },
            f0: null,
            f1: variables["e0_1"] ? { text: SKILL_MD } : null,
            f2: null,
          },
          s1: null,
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
  const page = (source: string, name?: string) =>
    row("p", { source, name }) as unknown as PageObjectResponse;

  it("reads owner/repo with a skill name as candidate folders", () => {
    expect(targetOf(page("acme/agent-skills", "frontend-design"))).toMatchObject({
      owner: "acme",
      repo: "agent-skills",
      folders: ["skills/frontend-design", "frontend-design", ".claude/skills/frontend-design"],
    });
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

  it("looks at the repo root without a skill name, and ignores non-GitHub sources", () => {
    expect(targetOf(page("acme/one-skill"))?.folders).toEqual([""]);
    expect(targetOf(page("https://gitlab.com/acme/x"))).toBeUndefined();
  });
});

describe("frontmatter", () => {
  it("reads name and description, unquoted", () => {
    expect(frontmatter(SKILL_MD)).toEqual({
      name: "frontend-design",
      description: "Build distinctive interfaces",
    });
  });

  it("joins a folded (>) description and keeps a literal (|) one's lines", () => {
    const folded =
      "---\nname: ponytail\ndescription: >\n  Lazy senior dev mode:\n  the smallest change.\nlicense: MIT\n---\n";
    expect(frontmatter(folded)).toEqual({
      name: "ponytail",
      description: "Lazy senior dev mode: the smallest change.",
    });
    const literal = "---\ndescription: |-\n  line one\n  line two\n---\n";
    expect(frontmatter(literal).description).toBe("line one\nline two");
  });
});

describe("syncSkills", () => {
  it("fills Purpose, Website, Skill name and a missing icon from SKILL.md", async () => {
    const calls = fakeApis([
      row("skill-1", { source: "acme/agent-skills", name: "frontend-design" }),
      row("skill-2", { source: "acme/gone" }),
      row("tech-1", { source: "acme/agent-skills", type: "Framework" }),
    ]);
    await syncSkills(env);
    const written = await patches(calls);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe("/v1/pages/skill-1");
    expect(written[0]?.body).toMatchObject({
      icon: { type: "external", external: { url: "https://avatars.githubusercontent.com/u/9" } },
      properties: {
        Purpose: { rich_text: [{ text: { content: "Build distinctive interfaces" } }] },
        Website: { url: "https://github.com/acme/agent-skills/tree/main/frontend-design" },
      },
    });
    // Skill name was already set, so it is left alone.
    expect(written[0]?.body["properties"]).not.toHaveProperty("Skill name");

    const query = calls.find((c) => c.url.includes("graphql"));
    const body = await query?.json<{ query: string; variables: Record<string, string> }>();
    expect(body?.query).not.toContain("acme");
    expect(body?.variables).toMatchObject({
      o0: "acme",
      n0: "agent-skills",
      e0_0: "HEAD:skills/frontend-design/SKILL.md",
    });
  });

  it("writes nothing when every value already matches and the page has an icon", async () => {
    const current = row("skill-1", {
      source: "acme/agent-skills",
      name: "frontend-design",
      icon: { type: "emoji", emoji: "🎨" },
    });
    current.properties.Purpose = {
      type: "rich_text",
      rich_text: [{ plain_text: "Build distinctive interfaces" }],
    };
    (current.properties.Website as { url: string | null }).url =
      "https://github.com/acme/agent-skills/tree/main/frontend-design";
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
