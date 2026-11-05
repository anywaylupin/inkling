import { env } from "cloudflare:test";
import { vi } from "vitest";
import type { Env } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env {
      PARA_STATE: KVNamespace;
    }
  }
}

/** Fake secrets only; real tokens never belong in tests. */
export const testEnv: Env = {
  PARA_STATE: env.PARA_STATE,
  NOTION_TOKEN: "test-notion",
  INFRA_DATA_SOURCE_ID: "ds-1",
  GITHUB_TOKEN: "test-github",
  CF_API_TOKEN: "test-cloudflare",
  CF_ACCOUNT_ID: "acct-1",
  VERCEL_TOKEN: "test-vercel",
  RENDER_API_KEY: "test-render",
  ALERT_URL: "https://ntfy.sh/para-test",
};

/** Routes every outbound fetch to `handler` and records each request, so no test reaches a real API. */
export function mockFetch(
  handler: (url: URL, request: Request) => Response | Promise<Response>,
): Request[] {
  const calls: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    return handler(new URL(request.url), request);
  });
  return calls;
}

/** Answers with the fixture for the first route whose key the request path ends with, else a 404. */
export function routes(table: Record<string, unknown>) {
  return (url: URL) => {
    const match = Object.entries(table).find(([path]) => url.pathname.endsWith(path));
    return match ? Response.json(match[1]) : new Response("not found", { status: 404 });
  };
}
