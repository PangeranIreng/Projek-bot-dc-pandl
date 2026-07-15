/**
 * utils/errorLogger.js — Global error logger that posts structured error
 * embeds to the bot's dedicated Discord error-log channel.
 *
 * Exports:
 *   initErrorLogger(client)  — call once in clientReady to store the client
 *   logError(payload)        — post an error embed; safe to call before init
 *                              (queues internally, flushes once client is ready)
 */

import { EmbedBuilder } from "discord.js";
import { IDS } from "../config/ids.js";
import { logger } from "./logger.js";

let _client = null;
/** Queue of payloads received before initErrorLogger was called. */
const _queue = [];

/**
 * Initialise the error logger with the logged-in Discord client.
 * Must be called exactly once, inside the `clientReady` handler.
 * @param {import("discord.js").Client} client
 */
export function initErrorLogger(client) {
  _client = client;
  // Flush anything that was queued before the client was ready.
  for (const payload of _queue.splice(0)) {
    _sendError(payload).catch(() => {});
  }
}

/**
 * Post a structured error embed to the error-log channel.
 * Returns a promise that always resolves (never rejects).
 *
 * @param {{
 *   feature:  string,
 *   reason:   string,
 *   stage:    string,
 *   user?:    string,
 *   guild?:   string,
 *   channel?: string,
 *   command?: string,
 *   error?:   Error,
 * }} payload
 */
export async function logError(payload) {
  if (!_client) {
    // Client not ready yet — queue the payload and return immediately.
    _queue.push(payload);
    return;
  }
  return _sendError(payload).catch((e) => {
    logger.warn(`[ErrorLogger] Failed to send error embed: ${e.message}`);
  });
}

async function _sendError(payload) {
  const { feature, reason, stage, user, guild, channel, command, error } = payload ?? {};

  const fields = [
    { name: "🔧 Feature",    value: String(feature || "Unknown"), inline: true },
    { name: "📍 Stage",      value: String(stage   || "Unknown"), inline: true },
    { name: "💬 Reason",     value: truncate(String(reason || "No reason provided"), 1024), inline: false },
  ];

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
