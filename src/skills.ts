import type { PageObjectResponse } from "@notionhq/client";
import type { Env } from "./env";
import { graphql } from "./github";
import { logFailure, notionClient, queryAll, richText, text } from "./notion";
import { throttle } from "./throttle";

/** owner/repo, or a GitHub URL to the repo or to one folder in it (…/tree/<branch>/<path>). */
const GITHUB_SOURCE =
  /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)\/(.+?))?\/?$/;
const SLUG = /^[\w.-]+$/;

/** Notion writes per run; the rest of the 50 subrequests go to reads and the GitHub query. */
const WRITE_BUDGET = 40;

/** Rows looked up per run. shortcut: more GitHub-sourced rows than this go unchecked; page the lookup if that happens. */
const MAX_ROWS = 50;

/** The manifest each synced Kind keeps in its folder. */
const MANIFEST = { Skill: "SKILL.md", Plugin: ".claude-plugin/plugin.json" } as const;
type Kind = keyof typeof MANIFEST;
const MARKETPLACE = ".claude-plugin/marketplace.json";

interface Target {
  page: PageObjectResponse;
  kind: Kind;
  owner: string;
  repo: string;
  /** Folders that may hold the manifest, best first; "" is the repo root. */
  folders: string[];
  /** Branch named in a /tree/ URL; otherwise the default branch is used. */
  branch?: string;
}

interface FoundRepo {
  url: string;
  stargazerCount: number;
  owner: { avatarUrl: string };
  defaultBranchRef: { name: string } | null;
  m?: { text: string | null } | null;
  [file: `f${number}`]: { text: string | null } | null | undefined;
}

interface Meta {
  name?: string;
  description?: string;
  version?: string;
}

/** Where a row's manifest may be, from its Kind, Source and Slug; undefined for other Kinds or non-GitHub sources. */
export function targetOf(page: PageObjectResponse): Target | undefined {
  const kindProp = page.properties["Kind"];
  const kind = kindProp?.type === "select" ? kindProp.select?.name : undefined;
  if (kind !== "Skill" && kind !== "Plugin") return undefined;
  const match = GITHUB_SOURCE.exec(text(page.properties["Source"]).trim());
  if (!match) return undefined;
  const [, owner = "", repo = "", branch, path] = match;
  if (path) return { page, kind, owner, repo, branch, folders: [path] };
  const slug = text(page.properties["Slug"]).trim();
  if (!SLUG.test(slug)) return { page, kind, owner, repo, folders: [""] };
  const folders =
    kind === "Skill"
      ? [`skills/${slug}`, slug, `.claude/skills/${slug}`]
      : [`plugins/${slug}`, slug, ""];
  return { page, kind, owner, repo, folders };
}

/**
 * Reads name, description and version from SKILL.md frontmatter.
 *
 * Handles plain and quoted single-line values, and folded (>) or literal (|) blocks of indented lines.
 * shortcut: not a full YAML parser; switch to one if skills use anchors, escapes or multi-line quoted strings.
 */
export function frontmatter(markdown: string): Meta {
  const lines = (/^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "").split(/\r?\n/);
  const field = (key: string) => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return undefined;
    const value = lines[at]?.slice(key.length + 1).trim() ?? "";
    const block = /^([>|])[-+]?$/.exec(value)?.[1];
    if (!block) return value.replace(/^(["'])(.*)\1$/, "$2") || undefined;
    const body: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() && !/^\s/.test(line)) break;
      body.push(line.trim());
    }
    return (
      (block === ">" ? body.join(" ").replace(/\s+/g, " ") : body.join("\n")).trim() || undefined
    );
  };
  return { name: field("name"), description: field("description"), version: field("version") };
}

/** Reads name, description and version from a plugin.json; a malformed file reads as empty. */
export function pluginManifest(json: string): Meta {
  try {
    const { name, description, version } = JSON.parse(json) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    return { name: str(name), description: str(description), version: str(version) };
  } catch {
    return {};
  }
}

function marketplaceName(json: string | null | undefined): string | undefined {
  if (!json) return undefined;
  try {
    const { name } = JSON.parse(json) as { name?: unknown };
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fills Skills rows whose Kind is Skill or Plugin and whose Source points at GitHub.
 *
 * From SKILL.md or .claude-plugin/plugin.json: Description and Version, and Slug when empty.
 * From the repo: GitHub (the folder link), Stars, Marketplace for plugins when empty, and the owner's avatar as the icon when the page has none.
 * A row is written only when one of those values differs.
 */
export async function syncSkills(env: Env): Promise<void> {
  if (!env.SKILLS_DATA_SOURCE_ID) return;
  if (!env.GITHUB_TOKEN) {
    console.error("skills sync skipped: GITHUB_TOKEN is not set");
    return;
  }
  const notion = notionClient(env);
  const targets = (await queryAll(notion, env.SKILLS_DATA_SOURCE_ID))
    .map(targetOf)
    .filter((t): t is Target => t !== undefined)
    .slice(0, MAX_ROWS);
  if (targets.length === 0) return;

  // One query for every row; each value is a variable, so text typed in Notion cannot change the query.
  const variables: Record<string, unknown> = {};
  const defs: string[] = [];
  const parts: string[] = [];
  targets.forEach((t, i) => {
    const ref = t.branch ?? "HEAD";
    variables[`o${i}`] = t.owner;
    variables[`n${i}`] = t.repo;
    defs.push(`$o${i}: String!`, `$n${i}: String!`);
    const files = t.folders.map((folder, j) => {
      variables[`e${i}_${j}`] = `${ref}:${folder ? `${folder}/` : ""}${MANIFEST[t.kind]}`;
      defs.push(`$e${i}_${j}: String!`);
      return `f${j}: object(expression: $e${i}_${j}) { ... on Blob { text } }`;
    });
    if (t.kind === "Plugin") {
      variables[`m${i}`] = `${ref}:${MARKETPLACE}`;
      defs.push(`$m${i}: String!`);
      files.push(`m: object(expression: $m${i}) { ... on Blob { text } }`);
    }
    parts.push(
      `s${i}: repository(owner: $o${i}, name: $n${i}) { url stargazerCount owner { avatarUrl } defaultBranchRef { name } ${files.join(" ")} }`,
    );
  });
  const data = await graphql<Record<string, FoundRepo | null>>(
    env.GITHUB_TOKEN,
    `query(${defs.join(", ")}) {\n${parts.join("\n")}\n}`,
    variables,
  );

  const write = throttle(334);
  let budget = WRITE_BUDGET;
  for (const [i, t] of targets.entries()) {
    const repo = data[`s${i}`];
    if (!repo) continue;
    const j = t.folders.findIndex((_, k) => repo[`f${k}`]?.text);
    const manifest = repo[`f${j}`]?.text;
    if (j < 0 || !manifest) continue;
    const folder = t.folders[j] ?? "";
    const branch = t.branch ?? repo.defaultBranchRef?.name ?? "HEAD";
    const github = folder ? `${repo.url}/tree/${branch}/${folder}` : repo.url;
    const meta = t.kind === "Skill" ? frontmatter(manifest) : pluginManifest(manifest);
    const marketplace = t.kind === "Plugin" ? marketplaceName(repo.m?.text) : undefined;

    const props = t.page.properties;
    const properties: Record<string, unknown> = {};
    const setText = (name: string, value: string | undefined, onlyWhenEmpty = false) => {
      if (!value) return;
      const current = text(props[name]).trim();
      if (onlyWhenEmpty ? !current : current !== value.slice(0, 2000))
        properties[name] = richText(value);
    };
    setText("Description", meta.description);
    setText("Version", meta.version);
    setText("Slug", meta.name, true);
    setText("Marketplace", marketplace, true);
    if (props["GitHub"]?.type === "url" && props["GitHub"].url !== github) {
      properties["GitHub"] = { url: github };
    }
    if (props["Stars"]?.type === "number" && props["Stars"].number !== repo.stargazerCount) {
      properties["Stars"] = { number: repo.stargazerCount };
    }
    const icon = t.page.icon
      ? undefined
      : { type: "external" as const, external: { url: repo.owner.avatarUrl } };
    if (Object.keys(properties).length === 0 && !icon) continue;
    if (budget-- <= 0) break;
    await write(() =>
      notion.pages.update({
        page_id: t.page.id,
        ...(icon && { icon }),
        properties: properties as Parameters<typeof notion.pages.update>[0]["properties"],
      }),
    ).catch(logFailure);
  }
}
