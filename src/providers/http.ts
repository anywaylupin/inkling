import type { Check, Provider } from "./types";

const TIMEOUT_MS = 10_000;

const SLOW_MS = 2_000;

/** True for the error AbortSignal.timeout raises. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** One GET that reports the status code and elapsed time, without reading the body. */
async function probe(url: string): Promise<{ code: number; ms: number }> {
  const start = Date.now();
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  await res.body?.cancel();
  return { code: res.status, ms: Date.now() - start };
}

/**
 * Plain uptime check against a URL.
 *
 * A timeout is retried once because Render free services cold start and the first request often only wakes them.
 */
export const http: Provider = {
  id: "http",
  async check(url): Promise<Check> {
    if (!/^https?:\/\//.test(url)) {
      return { status: "Unknown", error: "Resource ID must be an http or https URL" };
    }
    let result;
    try {
      result = await probe(url).catch((error: unknown) => {
        if (isTimeout(error)) return probe(url);
        throw error;
      });
    } catch (error) {
      return { status: "Down", error: isTimeout(error) ? "Timed out twice" : "Unreachable" };
    }
    const { code, ms } = result;
    if (code >= 200 && code < 300) {
      return ms < SLOW_MS ? { status: "Up" } : { status: "Degraded", error: "Slower than 2 s" };
    }
    if (code >= 300 && code < 400) return { status: "Degraded", error: `Redirect ${code}` };
    return { status: "Down", error: `HTTP ${code}` };
  },
};
