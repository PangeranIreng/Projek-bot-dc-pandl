/**
 * src/features/luatools/handler.js — Message handler untuk Lua Tools.
 *
 * Menangani .lua file yang dikirim ke channel Obfuscator / Beautify / Deobfuscator.
 * Semua hasil dikirim via DM; log ke log channel masing-masing tool.
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
} from "./embed.js";

const MAX_FILE_SIZE = 1_000_000; // 1 MB

/**
 * Main entry point: called from messageCreate for every non-bot message.
 * Returns immediately if the message is not in a Lua Tools channel.
 *
 * @param {import("discord.js").Message} message
 */
export async function handleLuaToolsMessage(message) {
  const channels = ltDB.getChannels();
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
    // Delete user message silently
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fileBuffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      logger.warn(`[LuaTools] Gagal download file attachment: ${err.message}`);
      if (statusMsg) await statusMsg.edit({ embeds: [buildProcessErrorEmbed(tool)] }).catch(() => {});
      return;
    }

    const inputSize = fileBuffer.length;

    // ── Process file ───────────────────────────────────────────────────────
    let resultBuffer;
    let outputFileName;
    let processError = null;

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
      }
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
    const outputSize  = resultBuffer?.length ?? 0;

    // ── Handle processing error ────────────────────────────────────────────
    if (processError || !resultBuffer) {
      logger.warn(`[LuaTools] ${tool} gagal: ${processError}`);
      if (statusMsg) {
        await statusMsg.edit({ embeds: [buildProcessErrorEmbed(tool)] }).catch(() => {});
      }
      // Log failure
      await _sendLog(message.client, tool, {
        user:       message.author,
        inputFile:  fileName,
        outputFile: outputFileName ?? `${fileName}.out`,
        inputSize,
        outputSize: 0,
        duration:   durationSec,
        status:     "Gagal",
      });
      return;
    }

    // ── Send result to DM ──────────────────────────────────────────────────
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

    // ── Update channel embed ────────────────────────────────────────────────
    if (statusMsg) {
      if (dmOk) {
        await statusMsg.edit({ embeds: [buildChannelSuccessEmbed(tool)] }).catch(() => {});
      } else {
        await statusMsg.edit({ embeds: [buildDmFailedEmbed()] }).catch(() => {});
      }
    }

    if (!dmOk) return; // Don't log if DM failed (nothing was delivered)

    // ── Send log ───────────────────────────────────────────────────────────
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
      await statusMsg.edit({ embeds: [buildProcessErrorEmbed(tool)] }).catch(() => {});
    }
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

async function _sendLog(client, tool, data, fileAttachment = null) {
  try {
    const logChannels = ltDB.getLogChannels();
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
