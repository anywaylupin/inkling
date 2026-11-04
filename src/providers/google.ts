import type { Env } from "../env";
import { ApiError, getJson, missingSecret, type Provider, type Status } from "./types";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

/** Access tokens by account and scope for the isolate's life; Google issues them for an hour. */
const tokens = new Map<string, { token: string; expires: number }>();

/** Base64url without padding, as JWTs need. */
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Parses the GCP_SA_KEY secret; undefined when it is not valid service account JSON. */
function serviceAccount(env: Env): ServiceAccount | undefined {
  try {
    const key: Partial<ServiceAccount> = JSON.parse(env.GCP_SA_KEY ?? "");
    return key.client_email && key.private_key && key.project_id
      ? { client_email: key.client_email, private_key: key.private_key, project_id: key.project_id }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Trades a signed JWT for an OAuth access token, the service account flow without Google's SDK.
 *
 * Cached tokens save one subrequest per row, which matters under the Free plan cap.
 */
export async function googleToken(account: ServiceAccount, scope: string): Promise<string> {
  const cacheKey = `${account.client_email} ${scope}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: account.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const pem = account.private_key.replaceAll(/-----[^-]+-----|\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(new Uint8Array(signature))}`,
    }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ApiError(res.status);
  }
  const { access_token, expires_in } = await res.json<{
    access_token: string;
    expires_in: number;
  }>();
  tokens.set(cacheKey, { token: access_token, expires: Date.now() + expires_in * 1000 });
  return access_token;
}

/** A GCP_SA_KEY that is set but unreadable gets its own message, not the generic missing one. */
function badKey(env: Env) {
  return env.GCP_SA_KEY
    ? { status: "Unknown" as const, error: "GCP_SA_KEY is not a service account JSON key." }
    : missingSecret("GCP_SA_KEY");
}

/** The GA4 home of a property, or the GA start page when only a name is known. */
function analyticsLink(propertyId: string): string {
  return /^\d+$/.test(propertyId)
    ? `https://analytics.google.com/analytics/web/#/p${propertyId}/reports/intelligenthome`
    : "https://analytics.google.com";
}

/**
 * Reads a GA4 property id, or a property display name looked up through the Admin API.
 *
 * Up means the property recorded events since yesterday, which catches a broken tracking tag.
 */
export const googleanalytics: Provider = {
  id: "googleanalytics",
  cost: 3,
  link: analyticsLink,
  async check(resourceId, env) {
    const account = serviceAccount(env);
    if (!account) return badKey(env);
    const headers = {
      authorization: `Bearer ${await googleToken(account, "https://www.googleapis.com/auth/analytics.readonly")}`,
    };
    let propertyId = resourceId;
    if (!/^\d+$/.test(resourceId)) {
      const { accountSummaries = [] } = await getJson<{
        accountSummaries?: { propertySummaries?: { property: string; displayName: string }[] }[];
      }>("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", headers);
      const match = accountSummaries
        .flatMap((summary) => summary.propertySummaries ?? [])
        .find((property) => property.displayName.toLowerCase() === resourceId.toLowerCase());
      if (!match) {
        return {
          status: "Unknown",
          error: `No property named ${resourceId} for this service account`,
        };
      }
      propertyId = match.property.replace("properties/", "");
    }
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          dateRanges: [{ startDate: "yesterday", endDate: "today" }],
          metrics: [{ name: "eventCount" }],
        }),
      },
    );
    if (!res.ok) {
      await res.body?.cancel();
      throw new ApiError(res.status);
    }
    const report = await res.json<{ rows?: { metricValues: { value: string }[] }[] }>();
    const events = Number.parseInt(report.rows?.[0]?.metricValues[0]?.value ?? "0", 10);
    return events > 0
      ? { status: "Up", url: analyticsLink(propertyId) }
      : { status: "Down", error: "No events since yesterday", url: analyticsLink(propertyId) };
  },
};

/** Cloud Run reports one terminal condition for the whole service. */
const RUN_STATES: Record<string, Status> = {
  CONDITION_SUCCEEDED: "Up",
  CONDITION_RECONCILING: "Degraded",
  CONDITION_PENDING: "Degraded",
  CONDITION_FAILED: "Down",
};

/**
 * Reads a Cloud Run service as `service` (in GCP_REGION) or `region/service`, in the service account's project.
 */
export const googlecloud: Provider = {
  id: "googlecloud",
  cost: 2,
  link(resourceId, env) {
    const [region, service] = resourceId.includes("/")
      ? resourceId.split("/")
      : [env.GCP_REGION ?? "us-central1", resourceId];
    const project = serviceAccount(env)?.project_id ?? "";
    return `https://console.cloud.google.com/run/detail/${region}/${service}/metrics?project=${project}`;
  },
  async check(resourceId, env) {
    const account = serviceAccount(env);
    if (!account) return badKey(env);
    const [region, service] = resourceId.includes("/")
      ? resourceId.split("/")
      : [env.GCP_REGION ?? "us-central1", resourceId];
    const token = await googleToken(
      account,
      "https://www.googleapis.com/auth/cloud-platform.read-only",
    );
    const run = await getJson<{
      uri?: string;
      updateTime: string;
      terminalCondition?: { state: string };
      latestReadyRevision?: string;
    }>(
      `https://run.googleapis.com/v2/projects/${account.project_id}/locations/${region}/services/${service}`,
      { authorization: `Bearer ${token}` },
    );
    const state = run.terminalCondition?.state ?? "CONDITION_PENDING";
    return {
      status: RUN_STATES[state] ?? "Unknown",
      lastDeploy: run.updateTime,
      deployState: run.latestReadyRevision?.split("/").at(-1) ?? state,
      url: run.uri,
    };
  },
};

/** Lists models with the API key: Up means the key works and the Gemini API answers. */
export const googlegemini: Provider = {
  id: "googlegemini",
  cost: 1,
  link: () => "https://aistudio.google.com/usage",
  async check(_resourceId, env) {
    if (!env.GEMINI_API_KEY) return missingSecret("GEMINI_API_KEY");
    await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      "x-goog-api-key": env.GEMINI_API_KEY,
    });
    return { status: "Up", deployState: "API key valid" };
  },
};
