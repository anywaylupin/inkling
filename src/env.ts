/**
 * Bindings and secrets the Worker reads.
 *
 * Provider secrets are optional so a missing one turns its rows Unknown instead of failing the run.
 */
export interface Env {
  PARA_STATE: KVNamespace;
  NOTION_TOKEN: string;
  INFRA_DATA_SOURCE_ID: string;
  /** Turns on the GitHub repo sync; without it the repo cron does nothing. */
  REPOS_DATA_SOURCE_ID?: string;
  /** Turns on the agent skill sync; without it the skills cron does nothing. */
  SKILLS_DATA_SOURCE_ID?: string;
  GITHUB_TOKEN?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  VERCEL_TOKEN?: string;
  RENDER_API_KEY?: string;
  NEON_API_KEY?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  MISTRAL_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** The full JSON key file of a Google service account. */
  GCP_SA_KEY?: string;
  GCP_REGION?: string;
  ALERT_URL?: string;
  SYNC_SECRET?: string;
}
