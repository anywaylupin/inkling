import type { PageObjectResponse } from "@notionhq/client";
import type { Env } from "./env";
import { notionClient, text } from "./notion";
import { graphql, logFailure, queryAll, richText } from "./repos";
import { throttle } from "./throttle";

/** owner/repo, or a GitHub URL to the repo or to one folder in it (…/tree/<branch>/<path>). */
const GITHUB_SOURCE =
  /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)\/(.+?))?\/?$/;
const SKILL_NAME = /^[\w.-]+$/;

/** Notion writes per run; the rest of the 50 subrequests go to reads and the GitHub query. */
const WRITE_BUDGET = 40;

/** Rows looked up per run. shortcut: more GitHub-sourced skills than this go unchecked; page the lookup if that happens. */
const MAX_SKILLS = 50;

interface Target {
  page: PageObjectResponse;
  owner: string;
  repo: string;
  /** Folders that may hold SKILL.md, best first; "" is the repo root. */
  folders: string[];
  /** Branch named in a /tree/ URL; otherwise the default branch is used. */
  branch?: string;
}

interface Found {
  repository: {
    url: string;
    owner: { avatarUrl: string };
    defaultBranchRef: { name: string } | null;
    [file: `f${number}`]: { text: string | null } | null | undefined;
  } | null;
}

/** Where a row's SKILL.md may be, from its Source and Skill name; undefined when Source is not on GitHub. */
export function targetOf(page: PageObjectResponse): Target | undefined {
  const match = GITHUB_SOURCE.exec(text(page.properties["Source"]).trim());
  if (!match) return undefined;
  const [, owner = "", repo = "", branch, path] = match;
  if (path) return { page, owner, repo, branch, folders: [path] };
  const name = text(page.properties["Skill name"]).trim();
  const folders = SKILL_NAME.test(name) ? [`skills/${name}`, name, `.claude/skills/${name}`] : [""];
  return { page, owner, repo, folders };
}

/**
 * Reads the name and description from SKILL.md frontmatter.
 *
 * Handles plain and quoted single-line values, and folded (>) or literal (|) blocks of indented lines.
 * shortcut: not a full YAML parser; switch to one if skills use anchors, escapes or multi-line quoted strings.
 */
export function frontmatter(markdown: string): { name?: string; description?: string } {
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
  return { name: field("name"), description: field("description") };
}

/**
 * Fills Skills rows whose Source points at GitHub: Purpose from the SKILL.md description, Website as the skill folder,
 * Skill name when empty, and the owner's avatar as the icon when the page has none.
 *
 * Only rows with Type Skill are touched, and a row is written only when one of those values differs.
 */
export async function syncSkills(env: Env): Promise<void> {
  if (!env.SKILLS_DATA_SOURCE_ID) return;
  if (!env.GITHUB_TOKEN) {
    console.error("skills sync skipped: GITHUB_TOKEN is not set");
    return;
  }
  const notion = notionClient(env);
  const targets = (await queryAll(notion, env.SKILLS_DATA_SOURCE_ID))
    .filter((page) => {
      const type = page.properties["Type"];
      return type?.type === "select" && type.select?.name === "Skill";
    })
    .map(targetOf)
    .filter((t): t is Target => t !== undefined)
    .slice(0, MAX_SKILLS);
  if (targets.length === 0) return;

  // One query for every row; each value is a variable, so text typed in Notion cannot change the query.
  const variables: Record<string, unknown> = {};
  const defs: string[] = [];
  const parts: string[] = [];
  targets.forEach((t, i) => {
    variables[`o${i}`] = t.owner;
    variables[`n${i}`] = t.repo;
    defs.push(`$o${i}: String!`, `$n${i}: String!`);
    const files = t.folders.map((folder, j) => {
      variables[`e${i}_${j}`] = `${t.branch ?? "HEAD"}:${folder ? `${folder}/` : ""}SKILL.md`;
      defs.push(`$e${i}_${j}: String!`);
      return `f${j}: object(expression: $e${i}_${j}) { ... on Blob { text } }`;
    });
    parts.push(
      `s${i}: repository(owner: $o${i}, name: $n${i}) { url owner { avatarUrl } defaultBranchRef { name } ${files.join(" ")} }`,
    );
  });
  const data = await graphql<Record<string, Found["repository"]>>(
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
    const markdown = repo[`f${j}`]?.text;
    if (j < 0 || !markdown) continue;
    const folder = t.folders[j] ?? "";
    const branch = t.branch ?? repo.defaultBranchRef?.name ?? "HEAD";
    const website = folder ? `${repo.url}/tree/${branch}/${folder}` : repo.url;
    const meta = frontmatter(markdown);

    const props = t.page.properties;
    const properties: Record<string, unknown> = {};
    if (meta.description && text(props["Purpose"]) !== meta.description.slice(0, 2000)) {
      properties["Purpose"] = richText(meta.description);
    }
    if (props["Website"]?.type === "url" && props["Website"].url !== website) {
      properties["Website"] = { url: website };
    }
    if (meta.name && !text(props["Skill name"]).trim()) {
      properties["Skill name"] = richText(meta.name);
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
