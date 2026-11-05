import { beforeAll, describe, expect, it } from "vitest";
import { googleanalytics, googlecloud, googlegemini } from "../src/providers/google";
import cloudRun from "./fixtures/cloudrun-service.json";
import summaries from "./fixtures/ga-account-summaries.json";
import streams from "./fixtures/ga-data-streams.json";
import report from "./fixtures/ga-report.json";
import models from "./fixtures/gemini-models.json";
import { mockFetch, routes, testEnv } from "./helpers";

let env = testEnv;
let publicKey: CryptoKey;

/** A throwaway RSA key in the shape of a downloaded service account JSON file. */
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("expected a key pair");
  publicKey = pair.publicKey;
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("expected pkcs8 bytes");
  const der = new Uint8Array(exported);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  env = {
    ...testEnv,
    GCP_SA_KEY: JSON.stringify({
      client_email: `para-${crypto.randomUUID()}@acme.iam.gserviceaccount.com`,
      private_key: pem,
      project_id: "acme",
    }),
  };
});

/** Answers the token exchange, then the given routes. */
function google(table: Record<string, unknown>) {
  const api = routes(table);
  return mockFetch((url) =>
    url.hostname === "oauth2.googleapis.com"
      ? Response.json({ access_token: "test-access-token", expires_in: 3600 })
      : api(url),
  );
}

/** Decodes a base64url segment. */
function fromBase64url(segment: string): Uint8Array {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

describe("googlecloud", () => {
  it("signs a valid JWT and reads the Cloud Run service", async () => {
    const calls = google({ "/services/api": cloudRun });
    expect(await googlecloud.check("api", env)).toEqual({
      status: "Up",
      lastDeploy: "2026-11-02T07:30:00.000000Z",
      deployState: "api-00042-xyz",
      domain: "https://api-abc123-uc.a.run.app",
    });

    const assertion = new URLSearchParams(await calls[0]?.text()).get("assertion") ?? "";
    const [header = "", payload = "", signature = ""] = assertion.split(".");
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      fromBase64url(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
    const run = calls.find((c) => c.url.includes("run.googleapis.com"));
    expect(run?.url).toContain("/projects/acme/locations/us-central1/services/api");
    expect(run?.headers.get("authorization")).toBe("Bearer test-access-token");
  });

  it("reuses the token for the next row", async () => {
    const calls = google({ "/services/api": cloudRun });
    await googlecloud.check("europe-west1/api", env);
    expect(calls.some((c) => c.url.includes("oauth2"))).toBe(false);
    expect(calls[0]?.url).toContain("/locations/europe-west1/services/api");
  });

  it("explains an unreadable key", async () => {
    const result = await googlecloud.check("api", { ...testEnv, GCP_SA_KEY: "not json" });
    expect(result).toEqual({
      status: "Unknown",
      error: "GCP_SA_KEY is not a service account JSON key.",
    });
  });
});

describe("googleanalytics", () => {
  it("is Up when the property recorded events, finding it by display name", async () => {
    const calls = google({
      "/accountSummaries": summaries,
      "/dataStreams": streams,
      ":runReport": report,
    });
    expect(await googleanalytics.check("project-a", env)).toEqual({
      status: "Up",
      deployment: "https://analytics.google.com/analytics/web/#/p987654321/reports/intelligenthome",
      domain: "https://acme.dev",
    });
    expect(calls.at(-1)?.url).toContain("/properties/987654321:runReport");
  });

  it("is Down when no events arrived since yesterday", async () => {
    google({ ":runReport": { rowCount: 0 } });
    expect((await googleanalytics.check("987654321", env)).status).toBe("Down");
  });
});

describe("googlegemini", () => {
  it("is Up when the key lists models", async () => {
    const calls = google({ "/models": models });
    expect(
      await googlegemini.check("project-a", { ...testEnv, GEMINI_API_KEY: "test-gemini" }),
    ).toEqual({ status: "Up", deployState: "API key valid" });
    expect(calls[0]?.headers.get("x-goog-api-key")).toBe("test-gemini");
  });

  it("links to AI Studio when the key is missing", async () => {
    expect(await googlegemini.check("project-a", testEnv)).toMatchObject({
      errorLink: "https://aistudio.google.com/apikey",
    });
  });
});
