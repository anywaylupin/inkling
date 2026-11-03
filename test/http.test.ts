import { describe, expect, it, vi } from "vitest";
import { http } from "../src/providers/http";
import { mockFetch, testEnv } from "./helpers";

const URL_ = "https://example.com";

describe("http", () => {
  it("is Up on a fast 2xx", async () => {
    mockFetch(() => new Response("ok"));
    expect(await http.check(URL_, testEnv)).toEqual({ status: "Up" });
  });

  it("is Degraded on a slow 2xx", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(2500);
    mockFetch(() => new Response("ok"));
    expect(await http.check(URL_, testEnv)).toEqual({
      status: "Degraded",
      error: "Slower than 2 s",
    });
  });

  it("is Degraded on a redirect", async () => {
    mockFetch(() => new Response(null, { status: 301, headers: { location: "/" } }));
    expect(await http.check(URL_, testEnv)).toEqual({ status: "Degraded", error: "Redirect 301" });
  });

  it("is Down on a 5xx", async () => {
    mockFetch(() => new Response("bad", { status: 503 }));
    expect(await http.check(URL_, testEnv)).toEqual({ status: "Down", error: "HTTP 503" });
  });

  it("retries once after a timeout", async () => {
    let attempts = 0;
    const calls = mockFetch(() => {
      attempts += 1;
      if (attempts === 1) throw new DOMException("timed out", "TimeoutError");
      return new Response("ok");
    });
    expect(await http.check(URL_, testEnv)).toEqual({ status: "Up" });
    expect(calls).toHaveLength(2);
  });

  it("is Down after two timeouts", async () => {
    mockFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await http.check(URL_, testEnv)).toEqual({ status: "Down", error: "Timed out twice" });
  });

  it("does not retry other network errors", async () => {
    const calls = mockFetch(() => {
      throw new TypeError("network");
    });
    expect(await http.check(URL_, testEnv)).toEqual({ status: "Down", error: "Unreachable" });
    expect(calls).toHaveLength(1);
  });

  it("rejects a Resource ID that is not a URL", async () => {
    expect((await http.check("example.com", testEnv)).status).toBe("Unknown");
  });
});
