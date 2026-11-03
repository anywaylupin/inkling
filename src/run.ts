import type { Env } from "./env";
import { notionClient, queryMonitored, toProperties, type Row } from "./notion";
import { PROVIDER_IDS, providers, type Check, type ProviderId } from "./providers";
import { ApiError } from "./providers/types";
import { throttle } from "./throttle";

const HOUR_MS = 60 * 60 * 1000;

/** Fields whose change triggers a Notion write; Usage note rides along but never triggers one. */
const DIFF_FIELDS = ["status", "lastDeploy", "deployState", "usage", "error"] as const;

/** What the last run wrote for one row, keyed by page id inside each provider's KV entry. */
type Snapshot = Pick<Check, (typeof DIFF_FIELDS)[number]> & { checkedAt: string };

/** Picks the provider after `last` in round-robin order, skipping providers with no monitored rows. */
export function nextProvider(present: ProviderId[], last: string | null): ProviderId | undefined {
  const lastIndex = PROVIDER_IDS.findIndex((id) => id === last);
  return present.find((id) => PROVIDER_IDS.indexOf(id) > lastIndex) ?? present.at(0);
}

/** Runs one adapter and turns any throw into an Unknown row, logging the provider id and error code only. */
async function safeCheck(row: Row, env: Env): Promise<Check> {
  try {
    return await providers[row.provider].check(row.resourceId, env);
  } catch (error) {
    const code =
      error instanceof ApiError ? error.message : error instanceof Error ? error.name : "Error";
    console.error(`${row.provider} check failed: ${code}`);
    return { status: "Unknown", error: `Check failed: ${code}` };
  }
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

  const key = `snapshot:${providerId}`;
  const before = (await env.INKLING_STATE.get<Record<string, Snapshot>>(key, "json")) ?? {};
  const after: Record<string, Snapshot> = {};
  const write = throttle(334);

  for (const row of rows.filter((r) => r.provider === providerId)) {
    const check = await safeCheck(row, env);
    const prev = before[row.id];
    const changed = !prev || DIFF_FIELDS.some((field) => prev[field] !== check[field]);
    const stale = !prev || now.getTime() - Date.parse(prev.checkedAt) >= HOUR_MS;
    const checkedAt = stale ? now.toISOString() : prev.checkedAt;
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
        if (prev) after[row.id] = prev;
        continue;
      }
    }
    const { status, lastDeploy, deployState, usage, error } = check;
    after[row.id] = { status, lastDeploy, deployState, usage, error, checkedAt };
    if (prev && prev.status !== check.status) await alert(env, row, prev.status, check.status);
  }

  if (JSON.stringify(after) !== JSON.stringify(before)) {
    await env.INKLING_STATE.put(key, JSON.stringify(after));
  }
}
