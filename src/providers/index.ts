import { cloudflare } from "./cloudflare";
import { github } from "./github";
import { http } from "./http";
import { render } from "./render";
import type { Provider, ProviderId } from "./types";
import { vercel } from "./vercel";

export const providers = { http, github, cloudflare, vercel, render } satisfies Record<
  ProviderId,
  Provider
>;

export { PROVIDER_IDS, type Check, type ProviderId } from "./types";
