import { getJson, missingSecret, type Provider } from "./types";

/** Lists models with the API key: Up means the key works and the Mistral API answers. */
export const mistral: Provider = {
  id: "mistral",
  cost: 1,
  link: () => "https://console.mistral.ai/usage",
  async check(_resourceId, env) {
    if (!env.MISTRAL_API_KEY) return missingSecret("MISTRAL_API_KEY");
    await getJson("https://api.mistral.ai/v1/models", {
      authorization: `Bearer ${env.MISTRAL_API_KEY}`,
    });
    return { status: "Up", deployState: "API key valid" };
  },
};
