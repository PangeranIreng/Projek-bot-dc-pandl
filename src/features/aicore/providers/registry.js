/**
 * AI Provider Registry
 *
 * Central module that:
 *  - Knows about all supported providers
 *  - Auto-detects the provider from an API key's prefix
 *  - Returns the correct adapter for a provider ID
 */
import * as openai     from "./openai.js";
import * as gemini     from "./gemini.js";
import * as anthropic  from "./anthropic.js";
import * as groq       from "./groq.js";
import * as openrouter from "./openrouter.js";

/**
 * All supported providers.
 * Detection order matters: specific prefixes (sk-ant-, sk-or-, gsk_, AIza)
 * must be checked BEFORE the generic OpenAI sk- prefix.
 */
export const ALL_PROVIDERS = [anthropic, gemini, groq, openrouter, openai];

export { openai, gemini, anthropic, groq, openrouter };

/**
 * Auto-detect the provider from an API key.
 *
 * Returns the matching adapter, or null if the key doesn't match any
 * known prefix (caller should prompt the user to select manually).
 *
 * Note: OpenAI is the final fallback because its "sk-" prefix is a
 * superset of Anthropic/OpenRouter prefixes when checked naïvely.
 * The individual adapters' detectFromKey() methods handle exclusions.
 */
export function detect(apiKey) {
  for (const adapter of ALL_PROVIDERS) {
    if (adapter.detectFromKey(apiKey)) return adapter;
  }
  return null;
}

/**
 * Look up a provider adapter by its PROVIDER_ID string.
 * Falls back to the OpenAI adapter if the ID is unknown.
 */
export function get(providerId) {
  return ALL_PROVIDERS.find((p) => p.PROVIDER_ID === providerId) ?? openai;
}

/**
 * Return an array of { id, name, defaultModel } for display in Discord menus.
 */
export function list() {
  return ALL_PROVIDERS.map((p) => ({
    id:           p.PROVIDER_ID,
    name:         p.PROVIDER_NAME,
    defaultModel: p.DEFAULT_MODEL,
    models:       p.MODELS,
  }));
}
