/**
 * Groq provider adapter.
 *
 * Groq is OpenAI SDK-compatible with a custom base URL.
 * Key pattern: gsk_…
 */
import OpenAI from "openai";

export const PROVIDER_ID   = "groq";
export const PROVIDER_NAME = "Groq";
export const DEFAULT_MODEL = "llama-3.1-8b-instant";
export const MODELS = [
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "llama3-8b-8192",
  "mixtral-8x7b-32768",
  "gemma2-9b-it",
];

const BASE_URL = "https://api.groq.com/openai/v1";

// ── Key detection ─────────────────────────────────────────────────────────────

export function detectFromKey(apiKey) {
  return String(apiKey || "").trim().startsWith("gsk_");
}

export function validateKeyFormat(apiKey) {
  const v = String(apiKey || "").trim();
  if (!v.startsWith("gsk_") || v.length < 20) {
    const err = new Error("Groq API key harus dimulai dengan 'gsk_' dan panjang minimal 20 karakter.");
    err.code = "AI_KEY_FORMAT";
    throw err;
  }
  return v;
}

// ── Client lifecycle ──────────────────────────────────────────────────────────

export function createClient(apiKey, timeoutMs) {
  return new OpenAI({
    apiKey,
    baseURL: BASE_URL,
    timeout: Math.max(5000, Number(timeoutMs) || 30_000),
  });
}

export async function testConnection(client) {
  await client.models.list();
}

// ── Chat completions ──────────────────────────────────────────────────────────

export async function chatCompletions(client, model, messages, maxTokens, signal) {
  // Groq does not support image_url content parts for most models.
  // Strip image content parts and keep only text to avoid 400 errors.
  const safeMessages = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const textOnly = m.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
    return { ...m, content: textOnly };
  });

  const response = await client.chat.completions.create(
    {
      model,
      messages: safeMessages,
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
