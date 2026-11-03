import type { UpdateDataSourceParameters } from "@notionhq/client";

/** Pinned so a Notion API upgrade never changes behavior without a code change. */
export const NOTION_VERSION = "2026-03-11";

/**
 * Properties inkling owns and writes; every other property on the data source stays untouched.
 *
 * This file has only type imports so `pnpm setup:notion` can load it with plain Node.
 */
export const INKLING_PROPERTIES = {
  Status: {
    select: {
      options: [
        { name: "Up", color: "green" },
        { name: "Degraded", color: "yellow" },
        { name: "Down", color: "red" },
        { name: "Unknown", color: "gray" },
      ],
    },
  },
  "Last deploy": { date: {} },
  "Deploy state": { rich_text: {} },
  Usage: { number: { format: "percent" } },
  "Usage note": { rich_text: {} },
  "Last checked": { date: {} },
  Error: { rich_text: {} },
} satisfies NonNullable<UpdateDataSourceParameters["properties"]>;
