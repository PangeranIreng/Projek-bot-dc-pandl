/**
 * src/events/messageCreate.js — messageCreate event handler.
 * Routes messages to the appropriate feature: Scanner, BoomBox, Ticket threads,
 * Auto Thread, and the `!hesu` status command.
 */

import { logger }                from "../utils/logger.js";
import { logError }              from "../utils/errorLogger.js";
import { handleAttachmentMessage }   from "../handlers/messageHandler.js";
import { handleHesuCommand }         from "../features/scanner/hesuCommand.js";
import { handleBoomBoxMessage }      from "../features/boombox/handler.js";
import { handleTicketThreadMessage } from "../features/ticket/handler.js";
import { handleLuaToolsMessage }     from "../features/luatools/handler.js";
import { threadDB }              from "../database/threadDB.js";

// Dedup guard: Discord can occasionally fire messageCreate twice for the same
// message during reconnects. Bounded to a small rolling window.
const processedMessageIds = new Set();
const MAX_DEDUP_SIZE = 500;

/**
 * @param {import("discord.js").Message} message
 * @param {{ scanChannelId: string }} secrets
 */
export async function handleMessageCreate(message, secrets) {
  try {
    if (message.author?.bot) return;

    if (processedMessageIds.has(message.id)) {
      logger.warn(`Duplicate messageCreate for ${message.id} -- ignoring.`);
      return;
    }
    processedMessageIds.add(message.id);
    if (processedMessageIds.size > MAX_DEDUP_SIZE) {
      processedMessageIds.delete(processedMessageIds.values().next().value);
    }

    // Auto Thread
    if (!message.channel?.isThread() && threadDB.isEnabled(message.channelId)) {
      message.startThread({ name: "Chat Disini", autoArchiveDuration: 60 }).catch(() => {});
    }

    // Ticket threads get their own isolated handler
    if (message.channel?.isThread()) {
      await handleTicketThreadMessage(message);
      return;
    }

    // !hesu works in any channel
    if (message.content?.trim().toLowerCase() === "!hesu") {
      await handleHesuCommand(message, message.client);
      return;
    }

    // BoomBox runs on a different channel from the scanner
    await handleBoomBoxMessage(message);

    // Lua Tools: Obfuscator / Beautify / Deobfuscator channels
    await handleLuaToolsMessage(message);

    // Scanner: only active in the designated scan channel
    if (message.channelId !== secrets.scanChannelId) return;
    if (message.attachments.size === 0) return;
    await handleAttachmentMessage(message);

  } catch (err) {
    logger.error("Kesalahan tak terduga saat memproses pesan", err);
    await logError({
      feature: message.channelId === secrets.scanChannelId
        ? "Keylogger Scanner"
        : "Message Handler",
      reason:  err?.message ?? String(err),
      stage:   "messageCreate",
      user:    message.author?.id,
      guild:   message.guildId,
      channel: message.channelId,
      error:   err,
    }).catch(() => {});
  }
}
