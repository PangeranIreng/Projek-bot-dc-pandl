/**
 * src/features/luatools/handler.js — Message handler untuk Lua Tools.
 *
 * Menangani .lua file yang dikirim ke channel Obfuscator / Beautify / Deobfuscator.
 * Hasil dikirim via DM + reply di channel.
 * Jika DM gagal, file tetap dikirim di channel dengan pesan peringatan.
 * Log sukses dikirim ke log channel per-tool; log gagal dikirim ke Error Log.
 */

import { AttachmentBuilder } from "discord.js";
import { ltDB }              from "../../database/db.js";
import { logger }            from "../../utils/logger.js";
import { logError }          from "../../utils/errorLogger.js";
import { beautifyLua }       from "./beautify.js";
import { callLuaApi }        from "./api.js";
import {
  buildProcessingEmbed,
  buildChannelSuccessEmbed,
  buildWrongFileTypeEmbed,
  buildDmFailedEmbed,
  buildProcessErrorEmbed,
  buildDmEmbed,
  buildLogEmbed,
  buildErrorLogEmbed,
} from "./embed.js";

const MAX_FILE_SIZE = 1_000_000; // 1 MB

/**
 * Main entry point: called from messageCreate for every non-bot message.
 * Returns immediately if the message is not in a Lua Tools channel.
 *
 * @param {import("discord.js").Message} message
 */
export async function handleLuaToolsMessage(message) {
  const channels  = ltDB.getChannels();
  const channelId = message.channelId;

  // Determine which tool this channel belongs to
  let tool = null;
  if (channels.obfuscator   && channelId === channels.obfuscator)   tool = "obfuscator";
  if (channels.beautify     && channelId === channels.beautify)     tool = "beautify";
  if (channels.deobfuscator && channelId === channels.deobfuscator) tool = "deobfuscator";

  if (!tool) return; // not a Lua Tools channel — ignore

  // Ignore messages with no attachments (e.g. plain text, links)
  if (message.attachments.size === 0) return;

  const attachment = message.attachments.first();
  const fileName   = attachment.name ?? "file";
  const ext        = fileName.includes(".") ? "." + fileName.split(".").pop().toLowerCase() : "";

  // ── Validate file type ───────────────────────────────────────────────────
  if (ext !== ".lua") {
    try { await message.delete(); } catch { /* no permission */ }
    const errEmbed = buildWrongFileTypeEmbed(ext || "(tidak ada ekstensi)");
    const reply    = await message.channel.send({ embeds: [errEmbed] }).catch(() => null);
    if (reply) setTimeout(() => reply.delete().catch(() => {}), 8_000);
    return;
  }

  // ── Validate file size ───────────────────────────────────────────────────
  if (attachment.size > MAX_FILE_SIZE) {
    try { await message.delete(); } catch { /* no permission */ }
    const reply = await message.channel.send({
      content: "❌ Ukuran file terlalu besar. Maksimum 1 MB.",
    }).catch(() => null);
    if (reply) setTimeout(() => reply.delete().catch(() => {}), 8_000);
    return;
  }

  // ── Show "processing" embed in channel ──────────────────────────────────
  let statusMsg = null;
  try {
    statusMsg = await message.channel.send({ embeds: [buildProcessingEmbed(tool)] });
  } catch { /* no permission to send */ }

  // Delete user's original message
  try { await message.delete(); } catch { /* no permission */ }

  const startTime = Date.now();

  try {
    // ── Download file ──────────────────────────────────────────────────────
    let fileBuffer;
    try {
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`HTTP ${res.status} saat mengunduh file`);
      fileBuffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      const reason = err.message ?? "Gagal mengunduh file dari Discord";
      logger.warn(`[LuaTools] Gagal download file attachment: ${reason}`);
      if (statusMsg) await statusMsg.edit({ embeds: [buildProcessErrorEmbed(tool, reason)] }).catch(() => {});
      await _sendErrorLog(message.client, tool, {
        user: message.author, guild: message.guildId, channel: channelId,
        fileName, fileSize: attachment.size, reason,
      });
      return;
    }

    const inputSize = fileBuffer.length;

    // ── Process file ───────────────────────────────────────────────────────
    let resultBuffer;
    let outputFileName;
    let processError = null;
    let httpStatus   = null;
    let apiResponse  = null;

    if (tool === "beautify") {
      // Local beautify
      const baseName = fileName.replace(/\.lua$/i, "");
      outputFileName = `${baseName}_beautify.lua`;
      const res = beautifyLua(fileBuffer.toString("utf8"));
      if (res.ok) {
        resultBuffer = Buffer.from(res.result, "utf8");
      } else {
        processError = res.error;
      }
    } else {
      // API call (obfuscator or deobfuscator)
      const baseName = fileName.replace(/\.lua$/i, "");
      outputFileName = tool === "obfuscator"
        ? `${baseName}_obf.lua`
        : `${baseName}_deobf.lua`;
      const res = await callLuaApi(tool, fileBuffer, fileName);
      if (res.ok) {
        resultBuffer = res.result;
      } else {
        processError = res.error;
        httpStatus   = res.httpStatus ?? null;
        apiResponse  = res.apiResponse ?? null;
      }
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
    const outputSize  = resultBuffer?.length ?? 0;

    // ── Handle processing error ────────────────────────────────────────────
    if (processError || !resultBuffer) {
      logger.warn(`[LuaTools] ${tool} gagal: ${processError}`);
      if (statusMsg) {
        await statusMsg.edit({ embeds: [buildProcessErrorEmbed(tool, processError)] }).catch(() => {});
      }
      // Send error log to error log channel
      await _sendErrorLog(message.client, tool, {
        user: message.author, guild: message.guildId, channel: channelId,
        fileName, fileSize: inputSize,
        reason: processError ?? "Unknown error",
        httpStatus, apiResponse,
      });
      // Also report to system error logger
      await logError({
        feature: `LuaTools — ${tool}`,
        reason:  processError ?? "Unknown error",
        stage:   "Process File",
        user:    message.author?.id,
        guild:   message.guildId,
        channel: channelId,
      }).catch(() => {});
      return;
    }

    // ── Send result to DM + reply in channel ───────────────────────────────
    const fileAttachment = new AttachmentBuilder(resultBuffer, { name: outputFileName });
    const dmEmbed        = buildDmEmbed(tool, {
      inputFile:  fileName,
      outputFile: outputFileName,
      duration:   durationSec,
    });

    let dmOk = false;
    try {
      await message.author.send({ embeds: [dmEmbed], files: [fileAttachment] });
      dmOk = true;
    } catch {
      dmOk = false;
    }

    // ── Update channel embed + optional channel file delivery ───────────────
    if (statusMsg) {
      if (dmOk) {
        // DM berhasil — edit embed di channel ke success
        await statusMsg.edit({ embeds: [buildChannelSuccessEmbed(tool)] }).catch(() => {});
      } else {
        // DM gagal — edit embed + kirim file ke channel sebagai fallback
        await statusMsg.edit({ embeds: [buildDmFailedEmbed()] }).catch(() => {});
        try {
          // Kirim file ke channel sebagai fallback agar user tetap mendapatkan hasilnya
          await message.channel.send({
            content: `<@${message.author.id}> ⚠️ Gagal mengirim hasil ke DM. Aktifkan **Direct Message** lalu coba lagi.\nFile hasil tersedia di sini:`,
            files:   [new AttachmentBuilder(resultBuffer, { name: outputFileName })],
          });
        } catch (sendErr) {
          logger.warn(`[LuaTools] Gagal kirim file fallback ke channel: ${sendErr.message}`);
        }
      }
    }

    // ── Send success log ───────────────────────────────────────────────────
    await _sendLog(message.client, tool, {
      user:       message.author,
      inputFile:  fileName,
      outputFile: outputFileName,
      inputSize,
      outputSize,
      duration:   durationSec,
      status:     "Berhasil",
    }, new AttachmentBuilder(resultBuffer, { name: outputFileName }));

  } catch (err) {
    logger.error(`[LuaTools] Unexpected error in ${tool} handler:`, err);
    if (statusMsg) {
      await statusMsg.edit({ embeds: [buildProcessErrorEmbed(tool, err?.message)] }).catch(() => {});
    }
    await _sendErrorLog(message.client, tool, {
      user: message.author, guild: message.guildId, channel: channelId,
      fileName, fileSize: attachment.size,
      reason: err?.message ?? String(err),
      stack:  err?.stack,
    });
    await logError({
      feature: "LuaTools",
      reason:  err?.message ?? String(err),
      stage:   tool,
      user:    message.author?.id,
      guild:   message.guildId,
      channel: channelId,
      error:   err,
    }).catch(() => {});
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Send success log embed (with optional file attachment) to the tool's log channel. */
async function _sendLog(client, tool, data, fileAttachment = null) {
  try {
    const logChannels  = ltDB.getLogChannels();
    const logChannelId = logChannels[tool];
    if (!logChannelId) return;

    const logCh = await client.channels.fetch(logChannelId).catch(() => null);
    if (!logCh?.isTextBased()) return;

    const embed   = buildLogEmbed(tool, data);
    const payload = { embeds: [embed] };
    if (fileAttachment) payload.files = [fileAttachment];

    await logCh.send(payload);
  } catch (err) {
    logger.warn(`[LuaTools] Gagal kirim log ${tool}: ${err.message}`);
  }
}

/** Send error log embed to the tool's error log channel. */
async function _sendErrorLog(client, tool, data) {
  try {
    const logChannels  = ltDB.getLogChannels();
    const logChannelId = logChannels[tool];
    if (!logChannelId) return;

    const logCh = await client.channels.fetch(logChannelId).catch(() => null);
    if (!logCh?.isTextBased()) return;

    await logCh.send({ embeds: [buildErrorLogEmbed(tool, data)] });
  } catch (err) {
    logger.warn(`[LuaTools] Gagal kirim error log ${tool}: ${err.message}`);
  }
}
