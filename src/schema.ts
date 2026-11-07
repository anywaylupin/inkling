import type { UpdateDataSourceParameters } from "@notionhq/client";

/** Pinned so a Notion API upgrade never changes behavior without a code change. */
export const NOTION_VERSION = "2026-03-11";

type Properties = NonNullable<UpdateDataSourceParameters["properties"]>;

/** The command the Skills Install formula builds; kept here so `pnpm setup:notion` creates the same column. */
const INSTALL_FORMULA = `if(empty(prop("Source")), "", if(prop("Kind") == "Plugin", "/plugin marketplace add " + prop("Source") + "\\n/plugin install " + if(empty(prop("Slug")), "<plugin>", prop("Slug")) + "@" + if(empty(prop("Marketplace")), "<marketplace>", prop("Marketplace")), if(prop("Kind") == "Skill", "npx skills add " + prop("Source") + if(empty(prop("Slug")), "", " --skill " + prop("Slug")) + ifs(prop("Install scope") == "Claude project", " -a claude-code -y", prop("Install scope") == "All agents", " -g -y", " -g -a claude-code -y"), "")))`;

const select = (...names: string[]) => ({ select: { options: names.map((name) => ({ name })) } });

/**
 * Each module's data source: the env var naming it, the columns `pnpm setup:notion` creates, and the Status options its sync writes.
 *
 * Every other property on a data source stays untouched, so you can add your own.
 * Status is listed separately because the API cannot create status properties.
 * This file has only type imports so `pnpm setup:notion` can load it with plain Node.
 */
export const MODULES: Record<
  string,
  { env: string; properties: (dataSourceId: string) => Properties; statuses: string[] }
> = {
  Infra: {
    env: "INFRA_DATA_SOURCE_ID",
    properties: () => ({
      Deployment: { url: {} },
      Domain: { url: {} },
      "Last deploy": { date: {} },
      "Deploy state": { rich_text: {} },
      "Last checked": { date: {} },
      Error: { rich_text: {} },
    }),
    statuses: ["Up", "Degraded", "Down", "Unknown"],
  },
  Repos: {
    env: "REPOS_DATA_SOURCE_ID",
    properties: (id) => ({
      Key: { rich_text: {} },
      Description: { rich_text: {} },
      GitHub: { url: {} },
      Domain: { url: {} },
      Topics: { multi_select: {} },
      Language: { select: {} },
      Visibility: select("Public", "Private"),
      Origin: select("Own", "OSS", "Fork"),
      Stars: { number: {} },
      "Fork count": { number: {} },
      "Open PRs": { number: {} },
      "Open issues": { number: {} },
      "Default branch": { rich_text: {} },
      "Commit message": { rich_text: {} },
      "Latest release": { rich_text: {} },
      "Last commit": { date: {} },
      Released: { date: {} },
      "Last synced": { date: {} },
      "Forked from": { relation: { data_source_id: id, single_property: {} } },
    }),
    statuses: ["Planned", "Deprecated"],
  },
  Skills: {
    env: "SKILLS_DATA_SOURCE_ID",
    properties: () => ({
      Kind: select("Skill", "Plugin", "MCP server", "Agent"),
      Source: { rich_text: {} },
      Slug: { rich_text: {} },
      Marketplace: { rich_text: {} },
      Version: { rich_text: {} },
      Description: { rich_text: {} },
      GitHub: { url: {} },
      Stars: { number: {} },
      "Install scope": select("Claude global", "Claude project", "All agents"),
      Install: { formula: { expression: INSTALL_FORMULA } },
    }),
    statuses: [],
  },
};
