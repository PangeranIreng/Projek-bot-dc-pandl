/**
 * OpenRouter provider adapter.
 *
 * OpenRouter is OpenAI SDK-compatible with a custom base URL.
 * Key pattern: sk-or-v1-…  or  sk-or-…
 */
import OpenAI from "openai";

export const PROVIDER_ID     = "openrouter";
export const PROVIDER_NAME   = "OpenRouter";
export const DEFAULT_MODEL   = "openai/gpt-4o-mini";
export const SUPPORTS_VISION = true; // Vision support depends on the chosen model
export const MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-3-5-haiku",
  "google/gemini-flash-1.5",
  "meta-llama/llama-3.1-8b-instruct:free",
];

const BASE_URL = "https://openrouter.ai/api/v1";

// ── Key detection ─────────────────────────────────────────────────────────────

export function detectFromKey(apiKey) {
  const v = String(apiKey || "").trim();
  return v.startsWith("sk-or-");
}

/**
 * Returns true if the given model name is compatible with this provider.
 * OpenRouter uses the "vendor/model" format (e.g. "openai/gpt-4o-mini").
 */
export function isCompatibleModel(model) {
  const m = String(model || "").trim();
  // OpenRouter models always contain a "/" separator (e.g. "openai/gpt-4o")
  return MODELS.includes(m) || m.includes("/");
}

export function validateKeyFormat(apiKey) {
  const v = String(apiKey || "").trim();
  if (!v.startsWith("sk-or-") || v.length < 20) {
    const err = new Error("OpenRouter API key harus dimulai dengan 'sk-or-' dan panjang minimal 20 karakter.");
    err.code = "AI_KEY_FORMAT";
    throw err;
  }
  return v;
}

// ── Client lifecycle ──────────────────────────────────────────────────────────

export function createClient(apiKey, timeoutMs) {
  return new OpenAI({
    apiKey,
    baseURL:        BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": "https://keylogger-scanner-bot",
      "X-Title":      "Keylogger Scanner Bot",
    },
    timeout: Math.max(5000, Number(timeoutMs) || 30_000),
  });
}

export async function testConnection(client) {
  await client.models.list();
}

// ── Chat completions ──────────────────────────────────────────────────────────

export async function chatCompletions(client, model, messages, maxTokens, signal) {
  const response = await client.chat.completions.create(
    {
      model,
      messages,
      max_tokens: Math.min(4000, Math.max(300, Number(maxTokens) || 1800)),
    },
    { signal },
  );
  return response.choices?.[0]?.message?.content?.trim() ?? "";
}

// ── Model validation ─────────────────────────────────────────────────────────

export async function validateModel(client, model) {
  await client.models.retrieve(model);
}

// ── Error normalisation ───────────────────────────────────────────────────────

export function normalizeError(error) {
  return {
    status:    Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    message:   String(error?.message ?? ""),
    errorBody: error?.error ?? null,
  };
}
