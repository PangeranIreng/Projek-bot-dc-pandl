import { scanFile } from "./scanFile.js";
import { buildUnknownReport } from "./report.js";
import { buildScanEmbed } from "../utils/embedBuilder.js";
import { buildScanButtons } from "../utils/buttons.js";
import { saveScanContext } from "./scanContextStore.js";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";

const MAX_BUTTON_ROWS = 5; // Discord's hard cap on action rows per message

/**
 * Handle a message with attachments in the scan channel:
 * 1. Reject multi-file messages with a friendly explanation.
 * 2. Reply immediately with "analyzing" status.
 * 3. Download + scan the single attachment.
 * 4. Edit the status message into the final embed + interactive buttons.
 * Never throws -- all failures degrade to an UNKNOWN embed rather than
 * crashing the bot process.
 */
export async function handleAttachmentMessage(message) {
  const attachments = Array.from(message.attachments.values());
  if (attachments.length === 0) return;

  // Only one file per message -- multiple files at once are rejected before
  // any scan starts. This keeps the result embed clean (one result per
  // message) and prevents accidental scan spam.
  if (attachments.length > 1) {
    try {
      await message.reply(
        "⚠️ Hanya **satu file** yang dapat dipindai per pesan.\n" +
        "Silakan kirim ulang pesan dengan satu file saja, agar setiap file mendapat hasil scan yang jelas dan terpisah.",
      );
    } catch (err) {
      logger.error("Gagal mengirim pesan penolakan multi-file", err);
    }
    return;
  }

  const attachment = attachments[0];
  logger.info(`Mulai scan: ${attachment.name} (${attachment.size} bytes) dari pesan ${message.id}`);

  let statusMessage;
  try {
    statusMessage = await message.reply("⏳ Sedang menganalisis file...");
  } catch (err) {
    logger.error("Gagal mengirim pesan status", err);
    return;
  }

  let embed;
  let component;

  try {
    if (attachment.size > config.maxAttachmentSizeBytes) {
      embed = buildScanEmbed(
        buildUnknownReport({
          fileName: attachment.name,
          sizeBytes: attachment.size,
          scanTimeMs: 0,
          reason: "File terlalu besar untuk dianalisis; analisis dilewati karena ukuran file melebihi batas yang didukung bot.",
        }),
      );
    } else {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`Gagal mengunduh attachment (HTTP ${response.status})`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const scanStart = Date.now();
      const result = await scanFile(buffer, attachment.name, attachment.size);
      const elapsed = Date.now() - scanStart;
      logger.info(`Scan selesai: ${attachment.name} — level=${result.level} score=${result.confidence ?? "N/A"} waktu=${elapsed}ms`);

      embed = buildScanEmbed(result);
      const scanId = saveScanContext({ buffer, fileName: attachment.name, result });
      component = buildScanButtons(scanId, {
        hasWebhook: Boolean(result.webhook),
        hasIndicators: Boolean(result.indicators?.length),
      });
    }
  } catch (err) {
    logger.error(`Gagal memindai attachment ${attachment.name}`, err);
    embed = buildScanEmbed(
      buildUnknownReport({
        fileName: attachment.name || "unknown",
        sizeBytes: attachment.size || 0,
        scanTimeMs: 0,
        reason: `Terjadi kesalahan saat mengunduh/menganalisis: ${err.message}`,
      }),
    );
  }

  try {
    const payload = { content: "", embeds: [embed] };
    if (component) payload.components = [component];
    await statusMessage.edit(payload);
  } catch (err) {
    logger.error("Gagal mengedit pesan status dengan hasil scan", err);
  }
}
