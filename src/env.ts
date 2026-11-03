/**
 * Bindings and secrets the Worker reads.
 *
 * Provider secrets are optional so a missing one turns its rows Unknown instead of failing the run.
 */
export interface Env {
  INKLING_STATE: KVNamespace;
  NOTION_TOKEN: string;
  NOTION_DATA_SOURCE_ID: string;
  GITHUB_TOKEN?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  VERCEL_TOKEN?: string;
  RENDER_API_KEY?: string;
  ALERT_URL?: string;
}
