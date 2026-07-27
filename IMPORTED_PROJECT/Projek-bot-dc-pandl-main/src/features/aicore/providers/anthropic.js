/**
 * Anthropic Claude provider adapter.
 *
 * Uses the Anthropic Messages REST API directly (no SDK needed).
 * Key pattern: sk-ant-…
 */

export const PROVIDER_ID     = "anthropic";
export const PROVIDER_NAME   = "Anthropic Claude";
export const DEFAULT_MODEL   = "claude-3-5-haiku-20241022";
export const SUPPORTS_VISION = true;
export const MODELS = [
  "claude-3-5-haiku-20241022",
  "claude-3-5-sonnet-20241022",
  "claude-3-opus-20240229",
  "claude-3-haiku-20240307",
];

const BASE_URL        = "https://api.anthropic.com/v1";
const ANTHROPIC_VER   = "2023-06-01";

// ── Key detection ─────────────────────────────────────────────────────────────

export function detectFromKey(apiKey) {
  return String(apiKey || "").trim().startsWith("sk-ant-");
}

/**
 * Returns true if the given model name is compatible with this provider.
 */
export function isCompatibleModel(model) {
  const m = String(model || "").trim();
  return MODELS.includes(m) || m.startsWith("claude-");
}

export function validateKeyFormat(apiKey) {
  const v = String(apiKey || "").trim();
  if (!v.startsWith("sk-ant-") || v.length < 20) {
    const err = new Error("Anthropic API key harus dimulai dengan 'sk-ant-' dan panjang minimal 20 karakter.");
    err.code = "AI_KEY_FORMAT";
    throw err;
  }
  return v;
}

// ── Client lifecycle ──────────────────────────────────────────────────────────

export function createClient(apiKey, timeoutMs) {
  return { apiKey, timeoutMs: Math.max(5000, Number(timeoutMs) || 30_000) };
}

/** Test connection via GET /v1/models (available since Anthropic API v2024-09-20). */
export async function testConnection(client) {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), client.timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: {
        "x-api-key":         client.apiKey,
        "anthropic-version": ANTHROPIC_VER,
      },
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
 * Convert OpenAI-format content parts to Anthropic content blocks.
 */
function toAnthropicContent(content) {
  if (typeof content === "string") return content; // Anthropic accepts plain strings
  if (!Array.isArray(content)) return String(content);
  const blocks = content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text ?? "" };
    if (part.type === "image_url") {
      const url = part.image_url?.url ?? "";
      if (url.startsWith("data:")) {
        const [header, data] = url.split(",");
        const mediaType = header.replace("data:", "").replace(";base64", "");
        return {
          type:   "image",
          source: { type: "base64", media_type: mediaType, data },
        };
      }
      // Remote URL — Anthropic requires base64, fallback to text description
      return { type: "text", text: `[Image: ${url}]` };
    }
    return { type: "text", text: String(part.text ?? part.content ?? "") };
  });
  return blocks;
}

export async function chatCompletions(client, model, messages, maxTokens, signal) {
  const systemMsg = messages.find((m) => m.role === "system");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));

  const body = {
    model,
    max_tokens: Math.min(4000, Math.max(300, Number(maxTokens) || 1800)),
    messages:   turns,
    ...(systemMsg ? { system: typeof systemMsg.content === "string" ? systemMsg.content : JSON.stringify(systemMsg.content) } : {}),
  };

  const res = await fetch(`${BASE_URL}/messages`, {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         client.apiKey,
      "anthropic-version": ANTHROPIC_VER,
    },
    body:   JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    const err = new Error(errorBody?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.error  = errorBody?.error ?? null;
    throw err;
  }

  const data = await res.json();
  return data.content?.map((block) => block.text ?? "").join("") ?? "";
}

// ── Model validation ─────────────────────────────────────────────────────────

/**
 * Validate a model for Anthropic.
 * Anthropic's GET /v1/models/{model_id} endpoint returns model details if it exists.
 * Falls back to accepting any model that looks like a valid Claude identifier.
 */
export async function validateModel(client, model) {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), client.timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/models/${model}`, {
      headers: {
        "x-api-key":         client.apiKey,
        "anthropic-version": ANTHROPIC_VER,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // 404 = model not found; 401/403 = auth failure (surfaced from connectivity)
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
