import type { Env } from "./env";
import { notionClient, retrievePage, sameId, toRow } from "./notion";
import { syncRepos } from "./repos";
import { syncRow } from "./run";

/** Compares in constant time so response timing never leaks how much of the key matched. */
function sameSecret(given: string | null, expected: string): boolean {
  const a = new TextEncoder().encode(given ?? "");
  const b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** Takes the page id from a Notion button webhook (`data.id`) or a plain `{ "page_id": "..." }` body. */
function pageIdFrom(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = "data" in body ? body.data : undefined;
  const id =
    "page_id" in body
      ? body.page_id
      : typeof data === "object" && data !== null && "id" in data
        ? data.id
        : undefined;
  return typeof id === "string" && /^[\da-f-]{32,36}$/i.test(id) ? id : undefined;
}

/**
 * Handles `POST /sync`: syncs the page's data source now instead of waiting for its cron turn.
 *
 * An Infra row is checked on its own; a Repos or Tasks row runs the whole repo sync, which costs about the same.
 * The work runs after the response because Notion button webhooks expect a quick answer and an http check can take 20 s.
 * Without SYNC_SECRET the route answers 404, so the endpoint is off until you opt in.
 * The parent check stops a valid caller from pointing PARA at another page the connection can see.
 */
export async function handleSync(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!env.SYNC_SECRET) return new Response("Not found", { status: 404 });
  if (!sameSecret(request.headers.get("x-para-key"), env.SYNC_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pageId = pageIdFrom(await request.json().catch(() => undefined));
  if (!pageId) {
    return Response.json({ error: "Send page_id or a Notion webhook body" }, { status: 400 });
  }
  const found = await retrievePage(notionClient(env), pageId);
  const source = found?.dataSourceId;
  if (
    sameId(source, env.REPOS_DATA_SOURCE_ID) ||
    (env.REPOS_DATA_SOURCE_ID && sameId(source, env.TASKS_DATA_SOURCE_ID))
  ) {
    ctx.waitUntil(syncRepos(env));
    return Response.json({ syncing: pageId, source: "repos" }, { status: 200 });
  }
  const row = found && sameId(source, env.INFRA_DATA_SOURCE_ID) ? toRow(found.page) : undefined;
  if (!row) return Response.json({ error: "No syncable row with that id" }, { status: 404 });
  ctx.waitUntil(syncRow(env, row));
  return Response.json({ syncing: row.id, provider: row.provider }, { status: 200 });
}
