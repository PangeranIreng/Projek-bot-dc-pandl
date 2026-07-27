/**
 * src/features/aicore/conversation.js
 *
 * AI Conversation — natural multi-turn chat on top of AI Core.
 *
 * Message routing:
 *   - Image attachment                  → investigate() with vision
 *   - Non-image file / code block       → investigate() (code/file context)
 *   - Error patterns + explicit request → investigate()
 *   - Everything else                   → chatWithAI() with channel history
 *
 * Rate limiting (layered):
 *   1. Per-user cooldown (3 s) — stops individual spam
 *   2. Per-channel sliding window (3 msg / 60 s) — stops flood
 *   3. AI Core's own global limiter (3 req / min) — provider quota guard
 *
 * 429 handling:
 *   One retry after 5 s exponential backoff; on second failure → structured
 *   error embed sent to the error-log channel via reportError().
 *   API keys are never displayed or sent to any channel.
 */

import { EmbedBuilder } from "discord.js";
import {
  getAICoreConfig,
  getProviderConfiguration,
  isAICoreAllowed,
  isProviderQuotaExhausted,
  chatWithAI,
  investigate,
  redact,
  reportError,
  sleep,
} from "./core.js";
import { logger } from "../../utils/logger.js";

// ── Conversation memory ───────────────────────────────────────────────────────
// Map<channelId, { messages: Array<{role,content}>, lastActivity: number }>
const channelMemory = new Map();
const MEMORY_MAX_TURNS = 10;      // 10 entries = 5 user+assistant pairs
const MEMORY_TTL_MS   = 30 * 60 * 1000; // 30 minutes idle → clear context

// ── Per-user cooldown ─────────────────────────────────────────────────────────
const userLastMessage = new Map();
const USER_COOLDOWN_MS = 3_000;

// ── Per-channel sliding-window rate limit ─────────────────────────────────────
const channelRequestLog = new Map();
// Keep this ≤ MAX_REQUESTS_PER_MINUTE in core.js (currently 3) so conversation
// alone cannot exhaust the global per-minute budget.
const CHANNEL_MAX_PER_MINUTE = 3;

// ── Per-channel in-flight guard ───────────────────────────────────────────────
// Prevents a second request firing before the first one returns.
const channelInFlight = new Set();

// ── AI personality system prompt ──────────────────────────────────────────────
const SYSTEM_PROMPT = `Anda adalah AI Core Assistant untuk server Discord ini. Anda adalah asisten AI yang cerdas, membantu, dan ramah — spesialis di bidang developer tools, debugging, analisis kode, dan diskusi teknis maupun umum.

Pedoman:
• Jawab dalam bahasa Indonesia, kecuali user menggunakan bahasa lain — dalam kasus itu ikuti bahasa mereka.
• Gunakan format Markdown (kode, bold, list) agar jawaban mudah dibaca di Discord.
• Berikan jawaban yang konkret dan dapat ditindaklanjuti.
• Jika tidak yakin tentang sesuatu, tandai dengan jelas sebagai dugaan atau kemungkinan.
• Jangan pernah membagikan API key, secret, token, credential, atau informasi sensitif apapun.
• Jangan mengarang file, fungsi, atau path yang tidak ada.
• Pertahankan konteks percakapan sebelumnya dalam satu sesi.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true and records the timestamp if the user is within cooldown. */
function isOnCooldown(userId) {
  const last = userLastMessage.get(userId) ?? 0;
  if (Date.now() - last < USER_COOLDOWN_MS) return true;
  userLastMessage.set(userId, Date.now());
  return false;
}

/** Returns true if the channel has exceeded the per-minute message cap. */
function channelRateLimited(channelId) {
  const now = Date.now();
  const log = channelRequestLog.get(channelId) ?? [];
  // Evict entries older than 60 s
  const recent = log.filter((ts) => now - ts < 60_000);
  if (recent.length >= CHANNEL_MAX_PER_MINUTE) {
    channelRequestLog.set(channelId, recent);
    return true;
  }
  recent.push(now);
  channelRequestLog.set(channelId, recent);
  return false;
}

/** Get channel conversation history, pruning stale entries. */
function getHistory(channelId) {
  const entry = channelMemory.get(channelId);
  if (!entry) return [];
  if (Date.now() - entry.lastActivity > MEMORY_TTL_MS) {
    channelMemory.delete(channelId);
    return [];
  }
  return entry.messages;
}

/** Append a message pair (user + assistant) to channel history. */
function appendHistory(channelId, userContent, assistantContent) {
  const history = getHistory(channelId);
  history.push({ role: "user", content: userContent });
  history.push({ role: "assistant", content: assistantContent });
  // Keep only the last MEMORY_MAX_TURNS entries
  const trimmed = history.slice(-MEMORY_MAX_TURNS);
  channelMemory.set(channelId, { messages: trimmed, lastActivity: Date.now() });
}

/** Update lastActivity without changing messages (e.g. after investigation). */
function touchHistory(channelId) {
  const entry = channelMemory.get(channelId);
  if (entry) entry.lastActivity = Date.now();
}

// ── Routing logic ─────────────────────────────────────────────────────────────

const INVESTIGATION_KEYWORDS = /\b(investigasi|investigate|debug|debugging|analisa|analisis|analyze|traceback|exception|stack trace|error log|perbaiki|generate fix|kode bermasalah|code review|bug|crash|gagal total|eror kritis)\b/i;
const ERROR_PATTERN = /\b(error|exception|traceback|failed|crash|undefined|null pointer|segfault|ENOENT|ECONNREFUSED|TypeError|ReferenceError|SyntaxError|ERR_)\b/i;
const CODE_BLOCK_PATTERN = /```[\s\S]+?```/;

/**
 * Decide whether a message should go through investigate() rather than chatWithAI().
 *
 * Rules (in priority order):
 *   1. Image attachment → always investigate (vision mode)
 *   2. Non-image file attachment → investigate
 *   3. Code block in text → investigate (code analysis)
 *   4. Explicit investigation keyword → investigate
 *   5. Error pattern in a substantive message (≥ 20 chars) → investigate
 *   6. Everything else → normal conversation
 */
function shouldInvestigate(message, query) {
  const attachments = [...message.attachments.values()];
  if (attachments.some((a) => a.contentType?.startsWith("image/"))) return "vision";
  if (attachments.some((a) => !a.contentType?.startsWith("image/"))) return "file";
  if (CODE_BLOCK_PATTERN.test(query)) return "code";
  if (INVESTIGATION_KEYWORDS.test(query)) return "keyword";
  if (query.length >= 20 && ERROR_PATTERN.test(query)) return "error_pattern";
  return null;
}

// ── 429-aware request wrapper ─────────────────────────────────────────────────

/**
 * Call fn(); if it throws a TEMPORARY rate limit (rate_limit_429), wait
 * (honouring Retry-After) then retry ONCE.
 *
 * Rules:
 *  - quota_exhausted (billing ceiling) → NO retry, re-throw immediately.
 *  - rate_limit_429 (temporary throttle) → one retry after backoff (max 30 s).
 *  - Any other error → re-throw immediately.
 *  - A second 429 of any kind → re-throw immediately.
 *
 * This prevents the pattern:
 *   quota_exhausted → retry → quota_exhausted → retry → …
 */
async function withRateLimitRetry(fn) {
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // quota_exhausted is permanent — NEVER retry, even on attempt 0.
      const isQuotaExhausted     = err?.providerCategory === "quota_exhausted";
      // Temporary rate limit only (not quota_exhausted).
      const isTemporaryRateLimit = err?.providerCategory === "rate_limit_429";

      if (isQuotaExhausted) {
        // Propagate immediately; caller will display the quota message.
        throw err;
      }
      if (isTemporaryRateLimit && attempt === 0) {
        const waitMs = Math.min(err?.retryAfterMs ?? 10_000, 30_000);
        logger.warn(`[AI Conversation] rate_limit_429 — waiting ${waitMs}ms before single retry (Retry-After: ${err?.retryAfterMs ?? "n/a"}ms)`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
}

// ── Image helper (same approach as in core.js handleAICoreMessage) ─────────────

async function attachmentAsDataUrl(attachment) {
  if (!attachment?.contentType?.startsWith("image/") || Number(attachment.size) > 4_000_000) return null;
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${attachment.contentType};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * Handle a Discord message in the configured conversation channel.
 *
 * Returns true if the message was consumed (caller should stop routing),
 * false if it was not relevant (wrong channel / feature disabled / etc.).
 */
export async function handleAIConversationMessage(message) {
  const cfg = getAICoreConfig();

  // Feature gate
  if (!cfg.conversationChannelId || message.channelId !== cfg.conversationChannelId) return false;
  if (!cfg.conversation) return false;

  // Access check
  if (!isAICoreAllowed(message.member)) {
    await message.reply("❌ AI Conversation hanya tersedia untuk akses yang dikonfigurasi.").catch(() => {});
    return true;
  }

  const query = (message.content ?? "").trim();
  const attachments = [...message.attachments.values()];
  if (!query && attachments.length === 0) return false;

  // Per-user cooldown
  if (isOnCooldown(message.author.id)) {
    await message.reply("⏳ Tunggu sebentar sebelum mengirim pesan berikutnya.").catch(() => {});
    return true;
  }

  // Per-channel rate limit
  if (channelRateLimited(message.channelId)) {
    await message.reply("⚠️ Terlalu banyak permintaan dalam satu menit. Coba lagi sebentar.").catch(() => {});
    return true;
  }

  // ── Pre-flight quota guard ────────────────────────────────────────────────
  // If the provider is quota_exhausted, reject locally without sending any
  // API request. Display a clear message so the user knows to act.
  if (isProviderQuotaExhausted()) {
    await message.reply(
      "❌ **Provider Quota Habis**\n" +
      "Quota atau billing provider habis. Tidak ada request AI yang akan dikirim.\n" +
      "Ganti provider atau API key melalui `/setup` → ⚙️ AI Configuration."
    ).catch(() => {});
    return true;
  }

  // Per-channel in-flight guard — prevents a second request firing before the
  // first one returns, which would waste a provider request slot and risk 429.
  if (channelInFlight.has(message.channelId)) {
    await message.reply("⏳ Masih memproses pesan sebelumnya. Tunggu sebentar.").catch(() => {});
    return true;
  }
  channelInFlight.add(message.channelId);

  await message.channel.sendTyping().catch(() => {});

  const routeReason = shouldInvestigate(message, query);

  try {
    let answer;

    if (routeReason) {
      // ── Investigation route ─────────────────────────────────────────────
      let image = null;
      if (routeReason === "vision" || attachments.some((a) => a.contentType?.startsWith("image/"))) {
        const imgAttachment = attachments.find((a) => a.contentType?.startsWith("image/"));
        if (imgAttachment && cfg.visionAnalysis) {
          image = await attachmentAsDataUrl(imgAttachment);
        }
      }
      answer = await withRateLimitRetry(() => investigate({ query, image }));
      touchHistory(message.channelId);
    } else {
      // ── Conversation route ──────────────────────────────────────────────
      const history = getHistory(message.channelId);
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: redact(query) },
      ];
      answer = await withRateLimitRetry(() => chatWithAI(messages, 1400));
      appendHistory(message.channelId, redact(query), redact(answer));
    }

    // Discord message limit is 2000 chars; reply in chunks if needed
    const safe = redact(String(answer ?? "")).slice(0, 1900);
    await message.reply(safe).catch(() => {});

  } catch (err) {
    const providerReason = redact(String(err?.providerReason || err?.message || "Unknown error")).slice(0, 280);
    const category      = err?.providerCategory || "unknown";
    const httpStatus    = err?.httpStatus ?? null;
    const isRateLimit   = category === "rate_limit_429" || httpStatus === 429;
    const isQuota       = category === "quota_exhausted";
    const isLocalLimit  = /rate limit reached|concurrent_limit/i.test(`${err?.message ?? ""}${category}`);
    const retryAfterSec = err?.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : null;

    logger.warn(`[AI Conversation] Failed (${category}${httpStatus ? ` HTTP ${httpStatus}` : ""}): ${providerReason}`);

    // User-facing reply
    if (isLocalLimit) {
      await message.reply("⏳ AI Core sedang sibuk memproses request lain. Coba lagi dalam beberapa detik.").catch(() => {});
    } else if (isQuota) {
      await message.reply(
        `❌ **Quota Provider Habis** (HTTP 429)\nQuota atau billing provider habis. Periksa dashboard provider Anda.\nReason: ${providerReason}`
      ).catch(() => {});
    } else if (isRateLimit) {
      await message.reply(
        `❌ **Rate Limit** (HTTP 429)\nProvider membatasi permintaan.${retryAfterSec ? ` Retry-After: ${retryAfterSec}s.` : " Coba lagi dalam beberapa menit."}\nReason: ${providerReason}`
      ).catch(() => {});
    } else if (httpStatus) {
      await message.reply(`❌ **Provider Error** (HTTP ${httpStatus})\n${providerReason}`).catch(() => {});
    } else {
      await message.reply(`❌ AI Core tidak dapat memproses pesan ini.\n${providerReason}`).catch(() => {});
    }

    // Structured error to error-log channel (skips local-rate-limit and in-flight noise)
    if (!isLocalLimit) {
      void reportError({
        feature: "AI Core — Conversation",
        stage: "conversation_reply",
        reason: providerReason,
        errorCategory: category,
        activeProvider: getProviderConfiguration().provider,
        ...(httpStatus ? { status: String(httpStatus) } : {}),
        ...(err?.retryAfterMs ? { retryAfterMs: String(err.retryAfterMs) } : {}),
        metadata: {
          channelId: message.channelId,
          userId: message.author?.id,
          routeReason: routeReason ?? "chat",
          queryLength: query.length,
          hadAttachment: attachments.length > 0,
        },
      });
    }
  } finally {
    // Always release the in-flight lock so subsequent messages can be processed
    channelInFlight.delete(message.channelId);
  }

  return true;
}

/**
 * Clear the conversation history for a specific channel.
 * Can be called by a slash command or bot owner command.
 */
export function clearConversationHistory(channelId) {
  channelMemory.delete(channelId);
}

/**
 * Return a summary of the current memory state (for diagnostics).
 */
export function getConversationStats() {
  const now = Date.now();
  const active = [...channelMemory.entries()]
    .filter(([, v]) => now - v.lastActivity < MEMORY_TTL_MS)
    .map(([channelId, v]) => ({ channelId, turns: v.messages.length / 2 }));
  return { activeChannels: active.length, channels: active };
}
