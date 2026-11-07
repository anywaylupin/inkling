import { ApiError } from "./providers/types";

const GRAPHQL = "https://api.github.com/graphql";

/** Posts one GraphQL query; a null alias with a NOT_FOUND error means that repo is gone. */
export async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "para",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ApiError(res.status);
  }
  const body = await res.json<{ data?: T; errors?: { type?: string }[] }>();
  // Any error other than NOT_FOUND aborts the run, so a rate limit never reads as "every repo was deleted".
  const fatal = (body.errors ?? []).find((e) => e.type !== "NOT_FOUND");
  if (!body.data || fatal) throw new Error(`GitHub GraphQL ${fatal?.type ?? "returned no data"}`);
  return body.data;
}
