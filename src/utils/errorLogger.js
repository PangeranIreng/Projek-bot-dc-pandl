/**
 * utils/errorLogger.js — Global error logger that posts structured error
 * embeds to the bot's dedicated Discord error-log channel.
 *
 * Features:
 *   - Error deduplication: same (feature+stage+reason) within 5 min → skip
 *   - Queues errors that arrive before the client is ready
 *   - Fields: Feature, Stage, Reason, Suggestion, Stack, Timestamp
 *
 * Exports:
 *   initErrorLogger(client)  — call once in clientReady
 *   logError(payload)        — post an error embed; safe before init
 */

import { EmbedBuilder } from "discord.js";
import { IDS } from "../../config/constants.js";
import { logger } from "./logger.js";

let _client = null;
/** Queue of payloads received before initErrorLogger was called. */
const _queue = [];

// ── Deduplication ─────────────────────────────────────────────────────────────
// Key: "{feature}|{stage}|{reason_first_50_chars}"
// Value: { count, firstSeen, lastSeen, messageId? }
const _dedupMap  = new Map();
const DEDUP_TTL  = 5 * 60 * 1000; // 5 minutes
const DEDUP_MAX  = 500;           // max entries to keep in map

function _dedupKey(payload) {
  const f = String(payload.feature || "").slice(0, 40);
  const s = String(payload.stage   || "").slice(0, 40);
  const r = String(payload.reason  || "").slice(0, 60);
  return `${f}|${s}|${r}`;
}

/** Returns true if this error is a duplicate within the TTL window. */
function _isDuplicate(payload) {
  const key  = _dedupKey(payload);
  const now  = Date.now();
  const prev = _dedupMap.get(key);

  if (prev && (now - prev.lastSeen) < DEDUP_TTL) {
    // Update the count and lastSeen, but skip sending
    prev.count++;
    prev.lastSeen = now;
    _dedupMap.set(key, prev);
    return true;
  }

  // Register a new dedup entry
  if (_dedupMap.size >= DEDUP_MAX) {
    // Evict oldest entry
    const firstKey = _dedupMap.keys().next().value;
    _dedupMap.delete(firstKey);
  }
  _dedupMap.set(key, { count: 1, firstSeen: now, lastSeen: now });
  return false;
}

/**
 * Initialise the error logger with the logged-in Discord client.
 * Must be called exactly once, inside the `clientReady` handler.
 * @param {import("discord.js").Client} client
 */
export function initErrorLogger(client) {
  _client = client;
  for (const payload of _queue.splice(0)) {
    _sendError(payload).catch(() => {});
  }
}

/**
 * Post a structured error embed to the error-log channel.
 * Returns a promise that always resolves (never rejects).
 *
 * @param {{
 *   feature:     string,
 *   reason:      string,
 *   stage:       string,
 *   suggestion?: string,
 *   user?:       string,
 *   guild?:      string,
 *   channel?:    string,
 *   command?:    string,
 *   error?:      Error,
 *   provider?:   string,
 *   status?:     string,
 *   action?:     string,
 * }} payload
 */
export async function logError(payload) {
  if (!_client) {
    _queue.push(payload);
    return;
  }
  if (_isDuplicate(payload)) {
    const key  = _dedupKey(payload);
    const info = _dedupMap.get(key);
    logger.warn(`[ErrorLogger] Dedup skipped (${info?.count}x): ${payload.feature} — ${String(payload.reason).slice(0, 80)}`);
    return;
  }
  return _sendError(payload).catch((e) => {
    logger.warn(`[ErrorLogger] Failed to send error embed: ${e.message}`);
  });
}

async function _sendError(payload) {
  const { feature, reason, stage, suggestion, user, guild, channel, command, error, provider, status, action } = payload ?? {};

  const fields = [
    { name: "🔧 Feature",  value: String(feature || "Unknown"),                             inline: true  },
    { name: "📍 Stage",    value: String(stage   || "Unknown"),                             inline: true  },
    { name: "💬 Reason",   value: truncate(String(reason || "No reason provided"), 1024),   inline: false },
  ];

  if (suggestion) {
    fields.push({ name: "💡 Suggestion", value: truncate(String(suggestion), 512), inline: false });
  }

  if (provider) fields.push({ name: "📡 Provider", value: String(provider), inline: true });
  if (status)   fields.push({ name: "🚦 Status",   value: String(status),   inline: true });
  if (action)   fields.push({ name: "➡️ Action",   value: String(action),   inline: true });

  if (command) fields.push({ name: "💡 Command",  value: String(command), inline: true });
  if (user)    fields.push({ name: "👤 User",     value: `<@${user}>`,    inline: true });
  if (guild)   fields.push({ name: "🏠 Guild",    value: String(guild),   inline: true });
  if (channel) fields.push({ name: "📢 Channel",  value: `<#${channel}>`, inline: true });

  if (error?.stack) {
    fields.push({
      name:   "📜 Stack Trace",
      value:  "```\n" + truncate(error.stack, 900) + "\n```",
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ Bot Error")
    .addFields(fields)
    .setTimestamp()
    .setFooter({ text: "Keylogger Scanner Bot — Error Log" });

  try {
    const ch = await _client.channels.fetch(IDS.ERROR_LOG_CHANNEL_ID).catch(() => null);
    if (ch?.isTextBased()) {
      await ch.send({ embeds: [embed] });
    } else {
      logger.warn(`[ErrorLogger] Error-log channel ${IDS.ERROR_LOG_CHANNEL_ID} not found or not text-based`);
    }
  } catch (e) {
    logger.warn(`[ErrorLogger] Could not post to error channel: ${e.message}`);
  }
}

function truncate(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}
