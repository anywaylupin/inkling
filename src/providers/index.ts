import { amplify, apigateway, dynamodb, lambda } from "./aws";
import { cloudflare } from "./cloudflare";
import { github } from "./github";
import { googleanalytics, googlecloud, googlegemini } from "./google";
import { http } from "./http";
import { mistral } from "./mistral";
import { neon } from "./neon";
import { render } from "./render";
import type { Provider, ProviderId } from "./types";
import { vercel } from "./vercel";

export const providers = {
  http,
  github,
  cloudflare,
  vercel,
  render,
  neon,
  lambda,
  dynamodb,
  apigateway,
  amplify,
  mistral,
  googlegemini,
  googleanalytics,
  googlecloud,
} satisfies Record<ProviderId, Provider>;

export { PROVIDER_IDS, type Check, type ProviderId } from "./types";
