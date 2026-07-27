/**
 * OpenAI provider adapter.
 *
 * Uses the official openai SDK (already a project dependency).
 * Key pattern: sk- (but NOT sk-ant- or sk-or-v1-)
 */
import OpenAI from "openai";

export const PROVIDER_ID     = "openai";
export const PROVIDER_NAME   = "OpenAI";
export const DEFAULT_MODEL   = "gpt-4o-mini";
export const SUPPORTS_VISION = true;
export const MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
];

// ── Key detection ─────────────────────────────────────────────────────────────

/**
 * Detect whether an API key belongs to this provider.
 * Returns true only for plain OpenAI keys; Anthropic (sk-ant-) and
 * OpenRouter (sk-or-) keys are NOT matched here even though they start with sk-.
 */
export function detectFromKey(apiKey) {
  const v = String(apiKey || "").trim();
  return v.startsWith("sk-") && !v.startsWith("sk-ant-") && !v.startsWith("sk-or-");
}

/**
 * Returns true if the given model name is compatible with this provider.
 * Used when switching providers to decide whether to keep the current model
 * or reset to the default.
 */
export function isCompatibleModel(model) {
  const m = String(model || "").trim();
  return MODELS.includes(m) || m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("o3-") || m.startsWith("o4-");
}

export function validateKeyFormat(apiKey) {
  const v = String(apiKey || "").trim();
  if (!v.startsWith("sk-") || v.startsWith("sk-ant-") || v.startsWith("sk-or-") || v.length < 20) {
    const err = new Error("OpenAI API key harus dimulai dengan 'sk-' dan panjang minimal 20 karakter.");
    err.code = "AI_KEY_FORMAT";
    throw err;
  }
  return v;
}

// ── Client lifecycle ──────────────────────────────────────────────────────────

export function createClient(apiKey, timeoutMs) {
  return new OpenAI({ apiKey, timeout: Math.max(5000, Number(timeoutMs) || 30_000) });
}

export async function testConnection(client) {
  await client.models.list();
}

// ── Chat completions ──────────────────────────────────────────────────────────

/**
 * Send a chat completion request.
 * messages — standard OpenAI message array (already supports image_url content parts).
 */
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

/**
 * Validate that a model exists on this provider.
 * Throws if the model is rejected or unreachable.
 */
export async function validateModel(client, model) {
  await client.models.retrieve(model);
}

// ── Error classification ──────────────────────────────────────────────────────

/**
 * Normalise a raw SDK error to { status, message, errorBody } so that
 * core.js providerErrorCategory() can classify it uniformly.
 */
export function normalizeError(error) {
  return {
    status:    Number.isFinite(Number(error?.status))  ? Number(error.status)  : null,
    message:   String(error?.message ?? ""),
    errorBody: error?.error ?? null,
  };
}
