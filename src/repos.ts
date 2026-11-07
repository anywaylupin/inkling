import {
  isFullPage,
  type Client,
  type PageObjectResponse,
  type UpdatePageParameters,
} from "@notionhq/client";
import type { Env } from "./env";
import { notionClient, text } from "./notion";
import { ApiError } from "./providers/types";
import { throttle } from "./throttle";

const GRAPHQL = "https://api.github.com/graphql";
const REPO_KEY = /^[\w.-]+\/[\w.-]+$/;

/**
 * Notion writes one run may spend; reads and the GitHub queries use the rest of the 50 subrequests.
 *
 * shortcut: a fixed cap rather than a live subrequest count; count them if Notion reads grow past a few pages.
 */
const WRITE_BUDGET = 35;

/**
 * Repos looked up one by one: tracked repos you do not own, and owned rows missing from the list.
 *
 * shortcut: at most 100 per run, so more than 100 such rows means the rest go unchecked; page the lookups if that happens.
 */
const MAX_LOOKUPS = 100;

/**
 * Icon files that common frameworks expect, best first: square PNGs, then SVGs, then .ico.
 *
 * Covers Next.js app router (app/, src/app/), public/ folders (Next.js pages, Vite, CRA, Astro, Nuxt), SvelteKit static/ and repo roots.
 * shortcut: fixed paths; a repo keeping its logo elsewhere falls back to the owner's avatar.
 */
const ICON_PATHS = [
  "app/apple-icon.png",
  "src/app/apple-icon.png",
  "public/apple-touch-icon.png",
  "app/icon.png",
  "src/app/icon.png",
  "public/logo192.png",
  "public/icon.png",
  "public/logo.png",
  "static/favicon.png",
  "logo.png",
  "app/icon.svg",
  "src/app/icon.svg",
  "public/icon.svg",
  "public/logo.svg",
  "public/favicon.svg",
  "static/favicon.svg",
  "logo.svg",
  "app/favicon.ico",
  "src/app/favicon.ico",
  "public/favicon.ico",
  "favicon.ico",
] as const;

const REPO_FIELDS = `
  nameWithOwner name description url homepageUrl isPrivate isArchived isFork
  owner { login avatarUrl }
  parent { nameWithOwner }
  stargazerCount forkCount
  primaryLanguage { name }
  repositoryTopics(first: 20) { nodes { topic { name } } }
  pullRequests(states: OPEN) { totalCount }
  issues(states: OPEN) { totalCount }
  defaultBranchRef { name target { ... on Commit { committedDate messageHeadline url } } }
  latestRelease { tagName url publishedAt }
  openGraphImageUrl
  ${ICON_PATHS.map((path, i) => `i${i}: object(expression: "HEAD:${path}") { id }`).join("\n  ")}`;

export interface Repo {
  nameWithOwner: string;
  name: string;
  description: string | null;
  url: string;
  homepageUrl: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  owner: { login: string; avatarUrl: string };
  parent: { nameWithOwner: string } | null;
  stargazerCount: number;
  forkCount: number;
  primaryLanguage: { name: string } | null;
  repositoryTopics: { nodes: { topic: { name: string } }[] };
  pullRequests: { totalCount: number };
  issues: { totalCount: number };
  defaultBranchRef: {
    name: string;
    target: { committedDate?: string; messageHeadline?: string; url?: string } | null;
  } | null;
  latestRelease: { tagName: string; url: string; publishedAt: string | null } | null;
  openGraphImageUrl: string;
  /** One per ICON_PATHS entry, null when that file is missing. */
  [icon: `i${number}`]: { id: string } | null | undefined;
}

/** Posts one GraphQL query; a null alias with a NOT_FOUND error means that repo is gone. */
async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "para",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ApiError(res.status);
  }
  const body = await res.json<{ data?: T; errors?: { type?: string }[] }>();
  // Any error other than NOT_FOUND aborts the run, so a rate limit never reads as "every repo was deleted".
  const fatal = (body.errors ?? []).find((e) => e.type !== "NOT_FOUND");
  if (!body.data || fatal) throw new Error(`GitHub GraphQL ${fatal?.type ?? "returned no data"}`);
  return body.data;
}

/** Lists every repo the token's user owns, private ones included, up to 300. */
async function ownedRepos(token: string): Promise<{ login: string; repos: Repo[] }> {
  const query = `query($after: String) { viewer { login repositories(first: 100, after: $after, ownerAffiliations: [OWNER]) {
    pageInfo { hasNextPage endCursor } nodes { ${REPO_FIELDS} } } } }`;
  const repos: Repo[] = [];
  let after: string | null = null;
  let login = "";
  // shortcut: stops after 3 pages (300 repos); raise the loop limit for bigger accounts.
  for (let page = 0; page < 3; page++) {
    const data: {
      viewer: {
        login: string;
        repositories: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Repo[];
        };
      };
    } = await graphql(token, query, { after });
    login = data.viewer.login;
    repos.push(...data.viewer.repositories.nodes);
    if (!data.viewer.repositories.pageInfo.hasNextPage) break;
    after = data.viewer.repositories.pageInfo.endCursor;
  }
  return { login, repos };
}

/**
 * One query for the repos you track but do not own; null when the repo is gone or the token cannot see it.
 *
 * Every value goes in as a GraphQL variable, never into the query text, so a Key typed in Notion cannot change the query.
 */
async function lookup(token: string, keys: string[]): Promise<Map<string, Repo | null>> {
  if (keys.length === 0) return new Map();
  const variables: Record<string, unknown> = {};
  const defs: string[] = [];
  const parts: string[] = [];
  keys.forEach((key, i) => {
    const [owner, name] = key.split("/");
    variables[`ro${i}`] = owner;
    variables[`rn${i}`] = name;
    defs.push(`$ro${i}: String!`, `$rn${i}: String!`);
    parts.push(`r${i}: repository(owner: $ro${i}, name: $rn${i}) { ${REPO_FIELDS} }`);
  });
  const query = `query(${defs.join(", ")}) {\n${parts.join("\n")}\n}`;
  const data = await graphql<Record<string, Repo | null>>(token, query, variables);
  return new Map(keys.map((key, i) => [key, data[`r${i}`] ?? null]));
}

/** Reads every row of a data source, across all result pages. */
async function queryAll(notion: Client, dataSourceId: string): Promise<PageObjectResponse[]> {
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
    });
    pages.push(...res.results.filter(isFullPage));
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return pages;
}

function statusOf(page: PageObjectResponse): string {
  const prop = page.properties["Status"];
  return prop?.type === "status" ? (prop.status?.name ?? "") : "";
}

/** Rich text capped at Notion's 2000 characters, optionally linked. */
function richText(content: string, url?: string | null) {
  return {
    rich_text: [{ text: { content: content.slice(0, 2000), ...(url && { link: { url } }) } }],
  };
}

/**
 * The columns sync owns on a Repos row; Name, Origin, Status and every relation except Forked from stay yours.
 *
 * Status is only written to mark an archived repo Deprecated.
 */
export function repoProperties(
  repo: Repo,
  rowIds: Map<string, string>,
): NonNullable<UpdatePageParameters["properties"]> {
  const commit = repo.defaultBranchRef?.target;
  const release = repo.latestRelease;
  const parentId = repo.parent && rowIds.get(repo.parent.nameWithOwner.toLowerCase());
  return {
    Description: richText(repo.description || "No description"),
    GitHub: { url: repo.url },
    Domain: { url: repo.homepageUrl || null },
    Topics: { multi_select: repo.repositoryTopics.nodes.map((n) => ({ name: n.topic.name })) },
    Language: { select: repo.primaryLanguage && { name: repo.primaryLanguage.name } },
    Visibility: { select: { name: repo.isPrivate ? "Private" : "Public" } },
    Stars: { number: repo.stargazerCount },
    "Fork count": { number: repo.forkCount },
    "Open PRs": { number: repo.pullRequests.totalCount },
    "Open issues": { number: repo.issues.totalCount },
    "Default branch": richText(repo.defaultBranchRef?.name ?? "Empty repo"),
    "Last commit": { date: commit?.committedDate ? { start: commit.committedDate } : null },
    "Commit message": richText(commit?.messageHeadline ?? "No commits", commit?.url),
    "Latest release": richText(release?.tagName ?? "No releases", release?.url),
    Released: { date: release?.publishedAt ? { start: release.publishedAt } : null },
    ...(parentId && { "Forked from": { relation: [{ id: parentId }] } }),
    ...(repo.isArchived && { Status: { status: { name: "Deprecated" } } }),
  };
}

/** Icon hosts PARA has used, so sync knows which icons it may replace; FAVICON is the retired homepage-favicon service. */
const FAVICON = "https://www.google.com/s2/favicons";
const AVATAR = "https://avatars.githubusercontent.com/";
const RAW = "https://raw.githubusercontent.com/";

/**
 * The page icon: the first ICON_PATHS file in a public repo, otherwise the owner's avatar.
 *
 * Private repos always get the avatar, because raw file links need a GitHub session for them.
 */
export function repoIcon(repo: Repo): { type: "external"; external: { url: string } } {
  const path = ICON_PATHS.find((_, i) => repo[`i${i}`]);
  const branch = repo.defaultBranchRef?.name;
  const url =
    !repo.isPrivate && path && branch
      ? `${RAW}${repo.nameWithOwner}/${encodeURIComponent(branch)}/${path}`
      : repo.owner.avatarUrl;
  return { type: "external", external: { url } };
}

/** GitHub's generated repo card, and the host of social previews uploaded in repo settings. */
const COVERS = [
  "https://opengraph.githubassets.com/",
  "https://repository-images.githubusercontent.com/",
];

/**
 * The page cover: the repo's social preview, uploaded or generated, for public repos only.
 *
 * Private repos get none, because their preview links stop working without a GitHub session.
 */
export function repoCover(repo: Repo): { type: "external"; external: { url: string } } | null {
  return repo.isPrivate ? null : { type: "external", external: { url: repo.openGraphImageUrl } };
}

/** True when the row has no icon or cover, or one PARA set, so sync may replace it. */
function ownedBySync(
  file: PageObjectResponse["icon"] | PageObjectResponse["cover"],
  prefixes: string[],
): boolean {
  if (!file) return true;
  return file.type === "external" && prefixes.some((p) => file.external.url.startsWith(p));
}

/** A pending Notion write, run later in budget order. */
type Write = () => Promise<unknown>;

/**
 * One repo sync: GitHub repos onto Repos rows.
 *
 * Your own repos get rows created; repos you track by Key are updated; a repo that disappears is marked Deprecated.
 * A row is only written when its synced columns changed since the last run, tracked in KV.
 */
export async function syncRepos(env: Env, now = new Date()): Promise<void> {
  if (!env.REPOS_DATA_SOURCE_ID) return;
  if (!env.GITHUB_TOKEN) {
    console.error("repo sync skipped: GITHUB_TOKEN is not set");
    return;
  }
  const notion = notionClient(env);
  const reposSource = env.REPOS_DATA_SOURCE_ID;

  const repoRows = await queryAll(notion, reposSource);
  const rows = new Map<string, PageObjectResponse>();
  for (const page of repoRows) {
    const key = text(page.properties["Key"]).trim();
    if (REPO_KEY.test(key)) rows.set(key.toLowerCase(), page);
  }
  const rowIds = new Map([...rows].map(([key, page]) => [key, page.id]));

  const { login, repos: owned } = await ownedRepos(env.GITHUB_TOKEN);
  const ownedKeys = new Set(owned.map((r) => r.nameWithOwner.toLowerCase()));
  const lookupKeys = [...rows.keys()].filter((key) => !ownedKeys.has(key)).slice(0, MAX_LOOKUPS);
  const found = await lookup(env.GITHUB_TOKEN, lookupKeys);

  const snapshot: Record<string, string> =
    (await env.PARA_STATE.get("snapshot:repos", "json")) ?? {};
  const nextSnapshot = { ...snapshot };
  const nowIso = now.toISOString();

  const repoWrites: { key: string; props: string; write: Write }[] = [];
  const allRepos = [...owned, ...[...found.values()].filter((r): r is Repo => r !== null)];
  for (const repo of allRepos) {
    const key = repo.nameWithOwner.toLowerCase();
    const properties = repoProperties(repo, rowIds);
    const page = rows.get(key);
    // An icon or cover you picked yourself is never replaced.
    const icon =
      !page || ownedBySync(page.icon, [FAVICON, AVATAR, RAW]) ? repoIcon(repo) : undefined;
    const cover = !page || ownedBySync(page.cover, COVERS) ? repoCover(repo) : undefined;
    const props = JSON.stringify([properties, icon?.external.url, cover?.external.url]);
    if (page && snapshot[key] === props) continue;
    const synced = { "Last synced": { date: { start: nowIso } } };
    repoWrites.push({
      key,
      props,
      write: page
        ? () =>
            notion.pages.update({
              page_id: page.id,
              ...(icon && { icon }),
              ...(cover !== undefined && { cover }),
              properties: { ...properties, ...synced },
            })
        : () =>
            notion.pages.create({
              parent: { data_source_id: reposSource },
              icon,
              cover,
              properties: {
                Name: { title: [{ text: { content: repo.name } }] },
                Key: richText(repo.nameWithOwner),
                Origin: {
                  select: {
                    name: repo.isFork ? "Fork" : repo.owner.login === login ? "Own" : "OSS",
                  },
                },
                Status: { status: { name: repo.isArchived ? "Deprecated" : "Discovered" } },
                ...properties,
                ...synced,
              },
            }),
    });
  }
  for (const [key, repo] of found) {
    const page = rows.get(key);
    if (repo !== null || !page || statusOf(page) === "Deprecated") continue;
    repoWrites.push({
      key,
      props: "gone",
      write: () =>
        notion.pages.update({
          page_id: page.id,
          properties: { Status: { status: { name: "Deprecated" } } },
        }),
    });
  }

  const write = throttle(334);
  let budget = WRITE_BUDGET;
  for (const { key, props, write: run } of repoWrites) {
    if (budget-- <= 0) break;
    const ok = await write(run).then(
      () => true,
      (error: unknown) => (logFailure(error), false),
    );
    if (ok) nextSnapshot[key] = props;
  }
  if (JSON.stringify(nextSnapshot) !== JSON.stringify(snapshot)) {
    await env.PARA_STATE.put("snapshot:repos", JSON.stringify(nextSnapshot));
  }
}

/** Logs the error class only, never a response body. */
function logFailure(error: unknown): void {
  console.error(`notion write failed: ${error instanceof Error ? error.name : "Error"}`);
}
