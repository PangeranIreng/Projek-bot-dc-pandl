// Handles the 5 scan-result buttons (Full Preview, Download Preview, Copy
// Webhook, Copy Indicators, Scan Again). Every action reads from the
// in-memory scanContextStore keyed by the scanId embedded in the button's
// customId (`sk:<action>:<scanId>`).

import { AttachmentBuilder } from "discord.js";
import { getScanContext, saveScanContext } from "./scanContextStore.js";
import { buildFullPreviewEmbed } from "../utils/fullPreviewEmbed.js";
import { buildScanEmbed } from "../utils/embedBuilder.js";
import { buildScanButtons } from "../utils/buttons.js";
import { buildTextReport } from "../utils/reportBuilder.js";
import { scanFile } from "./scanFile.js";
import { logger } from "../utils/logger.js";

const EXPIRED_MESSAGE =
  "⚠ Konteks scan ini sudah tidak tersedia lagi (kemungkinan bot baru saja restart atau sudah lebih dari 30 menit). Silakan unggah ulang file untuk memindai lagi.";

export async function handleScanButtonInteraction(interaction) {
  const [, action, scanId] = interaction.customId.split(":");
  const context = getScanContext(scanId);

  if (!context) {
    await interaction.reply({ content: EXPIRED_MESSAGE, ephemeral: true });
    return;
  }

  const { buffer, fileName, result } = context;

  try {
    switch (action) {
      case "preview": {
        // Ephemeral per spec: Full Preview must only be visible to the
        // person who clicked, never posted publicly to the channel.
        await interaction.reply({ embeds: [buildFullPreviewEmbed(result)], ephemeral: true });
        break;
      }
      case "download": {
        // Per spec, Download Preview must produce the *analysis result*
        // (txt/html), not the original scanned file.
        const reportText = buildTextReport(result);
        const reportName = `${fileName.replace(/[^\w.-]/g, "_")}-analysis.txt`;
        const attachment = new AttachmentBuilder(Buffer.from(reportText, "utf8"), { name: reportName });
        await interaction.reply({
          content: `📥 Laporan analisis lengkap untuk \`${fileName}\`:`,
          files: [attachment],
          ephemeral: true,
        });
        break;
      }
      case "webhook": {
        await interaction.reply({
          content: result.webhook ? `\`\`\`${result.webhook}\`\`\`` : "Tidak ada webhook yang ditemukan pada file ini.",
          ephemeral: true,
        });
        break;
      }
      case "indicators": {
        const list = (result.indicators || []).map((i) => `• [${i.severity}] ${i.label}`).join("\n");
        await interaction.reply({
          content: list ? `\`\`\`${list}\`\`\`` : "Tidak ada indikator yang ditemukan pada file ini.",
          ephemeral: true,
        });
        break;
      }
      case "rescan": {
        // Ephemeral per spec: Scan Again must only be visible to the
        // person who clicked.
        await interaction.deferReply({ ephemeral: true });
        const freshResult = await scanFile(buffer, fileName, buffer.length);
        const newScanId = saveScanContext({ buffer, fileName, result: freshResult });
        await interaction.editReply({
          embeds: [buildScanEmbed(freshResult)],
          components: [
            buildScanButtons(newScanId, {
              hasWebhook: Boolean(freshResult.webhook),
              hasIndicators: Boolean(freshResult.indicators?.length),
            }),
          ],
        });
        break;
      }
      default:
        await interaction.reply({ content: "Aksi tidak dikenali.", ephemeral: true });
    }
  } catch (err) {
    logger.error(`Gagal menangani interaksi tombol '${action}'`, err);
    const errMsg = { content: "Terjadi kesalahan saat memproses aksi ini.", ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(errMsg).catch(() => {});
    } else {
      await interaction.reply(errMsg).catch(() => {});
    }
  }
}
