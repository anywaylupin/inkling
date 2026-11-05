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
const PR_KEY = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

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

const REPO_FIELDS = `
  nameWithOwner name description url homepageUrl isPrivate isArchived isFork
  owner { login }
  parent { nameWithOwner }
  stargazerCount forkCount
  primaryLanguage { name }
  repositoryTopics(first: 20) { nodes { topic { name } } }
  pullRequests(states: OPEN) { totalCount }
  issues(states: OPEN) { totalCount }
  defaultBranchRef { name target { ... on Commit { committedDate messageHeadline url } } }
  latestRelease { tagName url publishedAt }`;

export interface Repo {
  nameWithOwner: string;
  name: string;
  description: string | null;
  url: string;
  homepageUrl: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  owner: { login: string };
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
}

interface PullRequest {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
}

/** Posts one GraphQL query; a null alias with a NOT_FOUND error means that repo or pull request is gone. */
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

interface Lookups {
  authored: PullRequest[];
  reviewing: PullRequest[];
  /** null when the repo is gone or the token cannot see it. */
  repos: Map<string, Repo | null>;
  /** null when the pull request or its repo is gone. */
  prStates: Map<string, string | null>;
}

/**
 * One query for your open pull requests, pull requests waiting on your review, single repos and pull request states.
 *
 * Every value goes in as a GraphQL variable, never into the query text, so a Key typed in Notion cannot change the query.
 */
async function lookup(
  token: string,
  login: string,
  repoKeys: string[],
  prKeys: string[],
): Promise<Lookups> {
  const variables: Record<string, unknown> = {
    authored: `is:pr is:open archived:false author:${login}`,
    reviewing: `is:pr is:open archived:false review-requested:${login}`,
  };
  const defs = ["$authored: String!", "$reviewing: String!"];
  // shortcut: 50 pull requests per search; page the search if you have more open at once.
  const parts = [
    "authored: search(query: $authored, type: ISSUE, first: 50) { nodes { ...PR } }",
    "reviewing: search(query: $reviewing, type: ISSUE, first: 50) { nodes { ...PR } }",
  ];
  repoKeys.forEach((key, i) => {
    const [owner, name] = key.split("/");
    variables[`ro${i}`] = owner;
    variables[`rn${i}`] = name;
    defs.push(`$ro${i}: String!`, `$rn${i}: String!`);
    parts.push(`r${i}: repository(owner: $ro${i}, name: $rn${i}) { ${REPO_FIELDS} }`);
  });
  prKeys.forEach((key, i) => {
    const [, owner, name, number] = PR_KEY.exec(key) ?? [];
    variables[`po${i}`] = owner;
    variables[`pn${i}`] = name;
    variables[`pq${i}`] = Number(number);
    defs.push(`$po${i}: String!`, `$pn${i}: String!`, `$pq${i}: Int!`);
    parts.push(
      `p${i}: repository(owner: $po${i}, name: $pn${i}) { pullRequest(number: $pq${i}) { state } }`,
    );
  });
  const query = `query(${defs.join(", ")}) {\n${parts.join("\n")}\n}
fragment PR on PullRequest { number title url repository { nameWithOwner } }`;
  const data = await graphql<Record<string, unknown>>(token, query, variables);
  const prs = (alias: string) =>
    ((data[alias] as { nodes: (PullRequest | object)[] }).nodes ?? []).filter(
      (n): n is PullRequest => "number" in n,
    );
  return {
    authored: prs("authored"),
    reviewing: prs("reviewing"),
    repos: new Map(repoKeys.map((key, i) => [key, (data[`r${i}`] as Repo | null) ?? null])),
    prStates: new Map(
      prKeys.map((key, i) => {
        const repo = data[`p${i}`] as { pullRequest: { state: string } | null } | null;
        return [key, repo?.pullRequest?.state ?? null];
      }),
    ),
  };
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

/** A pending Notion write, run later in budget order. */
type Write = () => Promise<unknown>;

/**
 * One repo sync: GitHub repos onto Repos rows, and open pull requests onto Tasks rows.
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
  const tasksSource = env.TASKS_DATA_SOURCE_ID;

  const repoRows = await queryAll(notion, reposSource);
  const rows = new Map<string, PageObjectResponse>();
  for (const page of repoRows) {
    const key = text(page.properties["Key"]).trim();
    if (REPO_KEY.test(key)) rows.set(key.toLowerCase(), page);
  }
  const rowIds = new Map([...rows].map(([key, page]) => [key, page.id]));

  // shortcut: reads every task to find the ones mirroring pull requests; filter by Key if Tasks grows past a few hundred rows.
  const tasks = new Map<string, PageObjectResponse>();
  if (tasksSource) {
    for (const page of await queryAll(notion, tasksSource)) {
      const key = text(page.properties["Key"]).trim();
      if (PR_KEY.test(key)) tasks.set(key.toLowerCase(), page);
    }
  }
  const openTaskKeys = [...tasks]
    .filter(([, page]) => !["Done", "Cancelled"].includes(statusOf(page)))
    .map(([key]) => key)
    .slice(0, MAX_LOOKUPS);

  const { login, repos: owned } = await ownedRepos(env.GITHUB_TOKEN);
  const ownedKeys = new Set(owned.map((r) => r.nameWithOwner.toLowerCase()));
  const lookupKeys = [...rows.keys()].filter((key) => !ownedKeys.has(key)).slice(0, MAX_LOOKUPS);
  const found = await lookup(env.GITHUB_TOKEN, login, lookupKeys, openTaskKeys);

  const snapshot: Record<string, string> =
    (await env.PARA_STATE.get("snapshot:repos", "json")) ?? {};
  const nextSnapshot = { ...snapshot };
  const nowIso = now.toISOString();

  // Pull requests first: they are few and the ones you act on, so a big first repo import never starves them.
  const taskWrites: Write[] = [];
  if (tasksSource) {
    const open = new Map<string, { pr: PullRequest; authored: boolean }>();
    for (const pr of found.reviewing) open.set(prKey(pr), { pr, authored: false });
    for (const pr of found.authored) open.set(prKey(pr), { pr, authored: true });
    for (const [key, { pr, authored }] of open) {
      if (tasks.has(key)) continue;
      taskWrites.push(() => {
        const repoId = rowIds.get(pr.repository.nameWithOwner.toLowerCase());
        return notion.pages.create({
          parent: { data_source_id: tasksSource },
          properties: {
            Name: { title: [{ text: { content: pr.title.slice(0, 2000) } }] },
            Key: richText(`${pr.repository.nameWithOwner}#${pr.number}`),
            Issue: { url: pr.url },
            Status: { status: { name: authored ? "In progress" : "To do" } },
            ...(repoId && { Repo: { relation: [{ id: repoId }] } }),
          },
        });
      });
    }
    for (const key of openTaskKeys) {
      if (open.has(key)) continue;
      const state = found.prStates.get(key);
      // Still open but off your lists means your review is in; merged is done; closed or gone is cancelled.
      const status = state === "OPEN" || state === "MERGED" ? "Done" : "Cancelled";
      const page = tasks.get(key);
      if (!page) continue;
      taskWrites.push(() =>
        notion.pages.update({
          page_id: page.id,
          properties: { Status: { status: { name: status } } },
        }),
      );
    }
  }

  const repoWrites: { key: string; props: string; write: Write }[] = [];
  const allRepos = [...owned, ...[...found.repos.values()].filter((r): r is Repo => r !== null)];
  for (const repo of allRepos) {
    const key = repo.nameWithOwner.toLowerCase();
    const properties = repoProperties(repo, rowIds);
    const props = JSON.stringify(properties);
    const page = rows.get(key);
    if (page && snapshot[key] === props) continue;
    const synced = { "Last synced": { date: { start: nowIso } } };
    repoWrites.push({
      key,
      props,
      write: page
        ? () => notion.pages.update({ page_id: page.id, properties: { ...properties, ...synced } })
        : () =>
            notion.pages.create({
              parent: { data_source_id: reposSource },
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
  for (const [key, repo] of found.repos) {
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
  for (const task of taskWrites) {
    if (budget-- <= 0) break;
    await write(task).catch(logFailure);
  }
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

function prKey(pr: PullRequest): string {
  return `${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase();
}

/** Logs the error class only, never a response body. */
function logFailure(error: unknown): void {
  console.error(`notion write failed: ${error instanceof Error ? error.name : "Error"}`);
}
