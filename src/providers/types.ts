import type { Env } from "../env";

/** Round-robin order, also the set of values the Provider select may hold. */
export const PROVIDER_IDS = ["http", "github", "cloudflare", "vercel", "render"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type Status = "Up" | "Degraded" | "Down" | "Unknown";

/** One provider's verdict on one row; `usage` is a fraction, shown as a percent in Notion. */
export interface Check {
  status: Status;
  lastDeploy?: string;
  deployState?: string;
  usage?: number;
  usageNote?: string;
  error?: string;
}

export interface Provider {
  id: ProviderId;
  check(resourceId: string, env: Env): Promise<Check>;
}

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

/** The answer for a provider whose secret is not set. */
export function missingSecret(name: string): Check {
  return { status: "Unknown", error: `${name} is not set` };
}
