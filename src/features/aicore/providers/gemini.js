/**
 * Google Gemini provider adapter.
 *
 * Uses the Gemini REST API directly (no SDK dependency needed).
 * Key pattern: AIza…
 */

export const PROVIDER_ID     = "gemini";
export const PROVIDER_NAME   = "Google Gemini";
export const DEFAULT_MODEL   = "gemini-2.0-flash";
export const SUPPORTS_VISION = true;
export const MODELS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// ── Key detection ─────────────────────────────────────────────────────────────

export function detectFromKey(apiKey) {
  return String(apiKey || "").trim().startsWith("AIza");
}

/**
 * Returns true if the given model name is compatible with this provider.
 */
export function isCompatibleModel(model) {
  const m = String(model || "").trim();
  return MODELS.includes(m) || m.startsWith("gemini-");
}

export function validateKeyFormat(apiKey) {
  const v = String(apiKey || "").trim();
  if (!v.startsWith("AIza") || v.length < 20) {
    const err = new Error("Google Gemini API key harus dimulai dengan 'AIza' dan panjang minimal 20 karakter.");
    err.code = "AI_KEY_FORMAT";
    throw err;
  }
  return v;
}

// ── Client lifecycle ──────────────────────────────────────────────────────────

/** Gemini "client" is just a config object — no SDK instance needed. */
export function createClient(apiKey, timeoutMs) {
  return { apiKey, timeoutMs: Math.max(5000, Number(timeoutMs) || 30_000) };
}

export async function testConnection(client) {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), client.timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/models?key=${client.apiKey}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.error  = body?.error ?? null;
      throw err;
    }
  } finally {
    clearTimeout(handle);
  }
}

// ── Chat completions ──────────────────────────────────────────────────────────

/**
 * Convert OpenAI-format messages to the Gemini generateContent payload.
 *
 * OpenAI format:
 *   { role: "system"|"user"|"assistant", content: string | ContentPart[] }
 *
 * Gemini format:
 *   system_instruction: { parts: [{text}] }
 *   contents: [{ role: "user"|"model", parts: [{text}|{inline_data}] }]
 */
function toGeminiParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content) }];
  return content.map((part) => {
    if (part.type === "text") return { text: part.text ?? "" };
    if (part.type === "image_url") {
      // data URL: "data:<mime>;base64,<data>"
      const url = part.image_url?.url ?? "";
      if (url.startsWith("data:")) {
        const [header, data] = url.split(",");
        const mimeType = header.replace("data:", "").replace(";base64", "");
        return { inline_data: { mime_type: mimeType, data } };
      }
      // Remote URL: Gemini supports direct URLs in some cases
      return { file_data: { file_uri: url } };
    }
    return { text: String(part.text ?? part.content ?? "") };
  });
}

export async function chatCompletions(client, model, messages, maxTokens, signal) {
  const systemMsg = messages.find((m) => m.role === "system");
  const turns = messages.filter((m) => m.role !== "system");

  const contents = turns.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: toGeminiParts(m.content),
  }));

  const body = {
    contents,
    ...(systemMsg
      ? { system_instruction: { parts: toGeminiParts(systemMsg.content) } }
      : {}),
    generationConfig: {
      maxOutputTokens: Math.min(4000, Math.max(300, Number(maxTokens) || 1800)),
    },
  };

  const res = await fetch(
    `${BASE_URL}/models/${model}:generateContent?key=${client.apiKey}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal,
    },
  );

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    const err = new Error(errorBody?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.error  = errorBody?.error ?? null;
    throw err;
  }

  const data = await res.json();
  return (
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? ""
  );
}

// ── Model validation ─────────────────────────────────────────────────────────

/**
 * Validate a model by fetching its descriptor from the Gemini models API.
 * Throws HTTP 404 if the model does not exist.
 */
export async function validateModel(client, model) {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), client.timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/models/${model}?key=${client.apiKey}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.error  = body?.error ?? null;
      throw err;
    }
  } finally {
    clearTimeout(handle);
  }
}

// ── Error normalisation ───────────────────────────────────────────────────────

export function normalizeError(error) {
  return {
    status:    Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    message:   String(error?.message ?? ""),
    errorBody: error?.error ?? null,
  };
}
