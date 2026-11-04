import type { Client } from "@notionhq/client";
import type { Env } from "./env";
import { notionClient, queryMonitored, toProperties, type Row } from "./notion";
import { PROVIDER_IDS, providers, type Check, type ProviderId } from "./providers";
import { ApiError } from "./providers/types";
import { throttle } from "./throttle";

const HOUR_MS = 60 * 60 * 1000;

/** Fields whose change triggers a Notion write. */
const DIFF_FIELDS = ["status", "lastDeploy", "deployState", "url", "error"] as const;

/** What the last run wrote for one row, keyed by page id inside each provider's KV entry. */
type Snapshot = Pick<Check, (typeof DIFF_FIELDS)[number]> & { checkedAt: string };

/** Picks the provider after `last` in round-robin order, skipping providers with no monitored rows. */
export function nextProvider(present: ProviderId[], last: string | null): ProviderId | undefined {
  const lastIndex = PROVIDER_IDS.findIndex((id) => id === last);
  return present.find((id) => PROVIDER_IDS.indexOf(id) > lastIndex) ?? present.at(0);
}

/**
 * Runs one adapter and turns any throw into an Unknown row, logging the provider id and error code only.
 *
 * The provider's static link fills URL whenever the check has none, so the column is never empty.
 */
async function safeCheck(row: Row, env: Env): Promise<Check> {
  const provider = providers[row.provider];
  let check: Check;
  try {
    check = await provider.check(row.resourceId, env);
  } catch (error) {
    const code =
      error instanceof ApiError ? error.message : error instanceof Error ? error.name : "Error";
    console.error(`${row.provider} check failed: ${code}`);
    check = { status: "Unknown", error: `Check failed: ${code}` };
  }
  return { ...check, url: check.url ?? provider.link(row.resourceId, env) };
}

/** Posts a status change to the ntfy topic; the row name stays in the body because headers must be Latin-1. */
async function alert(env: Env, row: Row, from: string, to: string): Promise<void> {
  if (!env.ALERT_URL) return;
  try {
    const res = await fetch(env.ALERT_URL, {
      method: "POST",
      headers: { title: "inkling", tags: to === "Up" ? "white_check_mark" : "warning" },
      body: `${row.name || row.resourceId} is ${to}, was ${from}`,
    });
    await res.body?.cancel();
    if (!res.ok) console.error(`alert failed: HTTP ${res.status}`);
  } catch (error) {
    console.error(`alert failed: ${error instanceof Error ? error.name : "Error"}`);
  }
}

/** What one row update needs besides the row itself. */
interface UpdateContext {
  env: Env;
  notion: Client;
  now: Date;
  write: ReturnType<typeof throttle>;
}

/**
 * Checks one row, patches Notion when something changed or Last checked is due, and alerts on a status change.
 *
 * Returns the row's new snapshot, or the previous one when the Notion write failed so the next run retries it.
 * `force` writes Last checked even within the hour, for manual refreshes.
 */
async function updateRow(
  { env, notion, now, write }: UpdateContext,
  row: Row,
  prev: Snapshot | undefined,
  force = false,
): Promise<Snapshot | undefined> {
  const check = await safeCheck(row, env);
  const changed = !prev || DIFF_FIELDS.some((field) => prev[field] !== check[field]);
  const stale = force || !prev || now.getTime() - Date.parse(prev.checkedAt) >= HOUR_MS;
  const checkedAt = stale || !prev ? now.toISOString() : prev.checkedAt;
  if (changed || stale) {
    try {
      await write(() =>
        notion.pages.update({
          page_id: row.id,
          properties: toProperties(check, stale ? checkedAt : undefined),
        }),
      );
    } catch (error) {
      console.error(`notion update failed: ${error instanceof Error ? error.name : "Error"}`);
      return prev;
    }
  }
  if (prev && prev.status !== check.status) await alert(env, row, prev.status, check.status);
  const { status, lastDeploy, deployState, url, error } = check;
  return { status, lastDeploy, deployState, url, error, checkedAt };
}

/** Reads one provider's snapshots from KV. */
async function readSnapshots(env: Env, providerId: ProviderId): Promise<Record<string, Snapshot>> {
  return (await env.INKLING_STATE.get(`snapshot:${providerId}`, "json")) ?? {};
}

/**
 * One cron tick: check every monitored row of one provider and patch only what changed.
 *
 * One provider per run keeps each invocation well under the Free plan's subrequest cap.
 */
export async function run(env: Env, now = new Date()): Promise<void> {
  const notion = notionClient(env);
  const rows = await queryMonitored(notion, env.NOTION_DATA_SOURCE_ID);
  const present = PROVIDER_IDS.filter((id) => rows.some((row) => row.provider === id));
  const providerId = nextProvider(present, await env.INKLING_STATE.get("cursor"));
  if (!providerId) return;
  await env.INKLING_STATE.put("cursor", providerId);

  const before = await readSnapshots(env, providerId);
  const after: Record<string, Snapshot> = {};
  const context = { env, notion, now, write: throttle(334) };
  for (const row of rows.filter((r) => r.provider === providerId)) {
    const next = await updateRow(context, row, before[row.id]);
    if (next) after[row.id] = next;
  }

  if (JSON.stringify(after) !== JSON.stringify(before)) {
    await env.INKLING_STATE.put(`snapshot:${providerId}`, JSON.stringify(after));
  }
}

/**
 * Checks a single row right away, for the refresh endpoint, and always writes Last checked.
 *
 * shortcut: the snapshot read-modify-write can race a cron run on the same provider and lose this row's entry, which only costs one extra Notion write on the next run; move snapshots to one KV key per row if refreshes get frequent.
 */
export async function refreshRow(env: Env, row: Row, now = new Date()): Promise<void> {
  const snapshots = await readSnapshots(env, row.provider);
  const context = { env, notion: notionClient(env), now, write: throttle(334) };
  const next = await updateRow(context, row, snapshots[row.id], true);
  if (!next) return;
  snapshots[row.id] = next;
  await env.INKLING_STATE.put(`snapshot:${row.provider}`, JSON.stringify(snapshots));
}
