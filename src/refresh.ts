import type { Env } from "./env";
import { notionClient, retrieveRow } from "./notion";
import { refreshRow } from "./run";

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
 * Handles `POST /refresh`: checks one row now instead of waiting for its provider's cron turn.
 *
 * The check runs after the response because Notion button webhooks expect a quick answer and an http check can take 20 s.
 * Without REFRESH_SECRET the route answers 404, so the endpoint is off until you opt in.
 */
export async function handleRefresh(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!env.REFRESH_SECRET) return new Response("Not found", { status: 404 });
  if (!sameSecret(request.headers.get("x-inkling-key"), env.REFRESH_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pageId = pageIdFrom(await request.json().catch(() => undefined));
  if (!pageId) {
    return Response.json({ error: "Send page_id or a Notion webhook body" }, { status: 400 });
  }
  const row = await retrieveRow(notionClient(env), env.NOTION_DATA_SOURCE_ID, pageId);
  if (!row) return Response.json({ error: "No monitored row with that id" }, { status: 404 });
  ctx.waitUntil(refreshRow(env, row));
  return Response.json({ refreshing: row.id, provider: row.provider }, { status: 202 });
}
