import type { Env } from "../env";

/** Round-robin order, also the set of values the Provider column may hold. */
export const PROVIDER_IDS = [
  "http",
  "github",
  "cloudflare",
  "vercel",
  "render",
  "neon",
  "lambda",
  "dynamodb",
  "mistral",
  "googlegemini",
  "googleanalytics",
  "googlecloud",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type Status = "Up" | "Degraded" | "Down" | "Unknown";

/**
 * One provider's verdict on one row.
 *
 * `deployment` links to the latest deploy's page and `domain` is the public address, each when the API reports one.
 *
 * `errorLink` turns the end of the Error text into a link, such as where to create a missing token.
 */
export interface Check {
  status: Status;
  lastDeploy?: string;
  deployState?: string;
  deployment?: string;
  domain?: string;
  error?: string;
  errorLink?: string;
}

export interface Provider {
  id: ProviderId;
  /** Worst-case subrequests one row costs, so a run can fit as many providers as the Free plan cap allows. */
  cost: number;
  check(resourceId: string, env: Env): Promise<Check>;
  /** A dashboard URL built without any API call; fills Deployment when the check reports none. */
  link(resourceId: string, env: Env): string;
  /** A public address built without any API call; fills Domain when the check reports none, else `link` does. */
  domain?(resourceId: string, env: Env): string;
}

/** Where to create each secret; a missing one shows this link in the Error column. */
const SECRET_DOCS = {
  GITHUB_TOKEN: "https://github.com/settings/personal-access-tokens/new",
  CF_API_TOKEN: "https://dash.cloudflare.com/profile/api-tokens",
  CF_ACCOUNT_ID:
    "https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/",
  VERCEL_TOKEN: "https://vercel.com/account/settings/tokens",
  RENDER_API_KEY: "https://dashboard.render.com/u/settings#api-keys",
  NEON_API_KEY: "https://console.neon.tech/app/settings/api-keys",
  AWS_ACCESS_KEY_ID: "https://console.aws.amazon.com/iam/home#/users",
  AWS_SECRET_ACCESS_KEY: "https://console.aws.amazon.com/iam/home#/users",
  AWS_REGION: "https://docs.aws.amazon.com/general/latest/gr/rande.html#regional-endpoints",
  MISTRAL_API_KEY: "https://console.mistral.ai/api-keys",
  GEMINI_API_KEY: "https://aistudio.google.com/apikey",
  GCP_SA_KEY: "https://console.cloud.google.com/iam-admin/serviceaccounts",
} satisfies Partial<Record<keyof Env, string>>;

/** Carries only the HTTP status, so logs and the Error column never echo a response body. */
export class ApiError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** Fetches JSON and throws ApiError on any non-2xx response. */
export async function getJson<T>(url: string, headers: HeadersInit): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ApiError(res.status);
  }
  return res.json<T>();
}

/** Turns a 404 into undefined for endpoints where "nothing yet" is a normal answer. */
export function orNotFound(error: unknown): undefined {
  if (error instanceof ApiError && error.status === 404) return undefined;
  throw error;
}

/** The answer for a provider whose secret is not set, linking to where to create it. */
export function missingSecret(name: keyof typeof SECRET_DOCS): Check {
  return { status: "Unknown", error: `${name} is not set.`, errorLink: SECRET_DOCS[name] };
}
