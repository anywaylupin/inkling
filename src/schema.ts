import type { UpdateDataSourceParameters } from "@notionhq/client";

/** Pinned so a Notion API upgrade never changes behavior without a code change. */
export const NOTION_VERSION = "2026-03-11";

/** Options the Status property must have; the API cannot create a status property, so you add them in Notion. */
export const STATUS_OPTIONS = ["Up", "Degraded", "Down", "Unknown"];

/**
 * Properties inkling owns and `pnpm setup:notion` can create; every other property on the data source stays untouched.
 *
 * Status is also inkling-owned but missing here because the API cannot create status properties.
 * This file has only type imports so `pnpm setup:notion` can load it with plain Node.
 */
export const INKLING_PROPERTIES = {
  Deployment: { url: {} },
  Domain: { url: {} },
  "Last deploy": { date: {} },
  "Deploy state": { rich_text: {} },
  "Last checked": { date: {} },
  Error: { rich_text: {} },
} satisfies NonNullable<UpdateDataSourceParameters["properties"]>;
