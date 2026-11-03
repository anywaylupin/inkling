import {
  Client,
  isFullPage,
  type PageObjectResponse,
  type UpdatePageParameters,
} from "@notionhq/client";
import type { Env } from "./env";
import { PROVIDER_IDS, type Check, type ProviderId } from "./providers";
import { NOTION_VERSION } from "./schema";

/** A monitored row with the fields inkling needs to check it. */
export interface Row {
  id: string;
  name: string;
  provider: ProviderId;
  resourceId: string;
}

/**
 * Builds the client for the Worker runtime.
 *
 * The logger is silenced because the client's warnings can carry response bodies, which must stay out of logs.
 */
export function notionClient(env: Env): Client {
  return new Client({
    auth: env.NOTION_TOKEN,
    notionVersion: NOTION_VERSION,
    fetch: (input, init) => fetch(input, init),
    logger: () => {},
  });
}

/** Reads a title, rich text or select property as plain text. */
function text(prop: PageObjectResponse["properties"][string] | undefined): string {
  if (prop?.type === "title") return prop.title.map((t) => t.plain_text).join("");
  if (prop?.type === "rich_text") return prop.rich_text.map((t) => t.plain_text).join("");
  if (prop?.type === "select") return prop.select?.name ?? "";
  return "";
}

/** True when the Provider select holds a value inkling has an adapter for. */
function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.some((id) => id === value);
}

/** Lists every row with Monitor ticked and both Provider and Resource ID set, across all result pages. */
export async function queryMonitored(notion: Client, dataSourceId: string): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await notion.dataSources.query({
      data_source_id: dataSourceId,
      filter: { property: "Monitor", checkbox: { equals: true } },
      start_cursor: cursor,
    });
    for (const result of page.results) {
      if (!isFullPage(result)) continue;
      const provider = text(result.properties["Provider"]);
      const resourceId = text(result.properties["Resource ID"]).trim();
      if (!isProviderId(provider) || !resourceId) continue;
      rows.push({ id: result.id, name: text(result.properties["Name"]), provider, resourceId });
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return rows;
}

/** Notion caps a rich text item at 2000 characters. */
function richText(value: string | undefined) {
  return { rich_text: value ? [{ text: { content: value.slice(0, 2000) } }] : [] };
}

/** Maps a Check onto inkling-owned properties; Last checked is only sent when `checkedAt` is given. */
export function toProperties(check: Check, checkedAt?: string): UpdatePageParameters["properties"] {
  return {
    Status: { select: { name: check.status } },
    "Last deploy": { date: check.lastDeploy ? { start: check.lastDeploy } : null },
    "Deploy state": richText(check.deployState),
    Usage: { number: check.usage ?? null },
    "Usage note": richText(check.usageNote),
    Error: richText(check.error),
    ...(checkedAt && { "Last checked": { date: { start: checkedAt } } }),
  };
}
