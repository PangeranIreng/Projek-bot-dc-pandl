/**
 * commands/delcbug.js — /delcbug
 *
 * Owner-only. Removes the Bug Report / Feature Request panel message and
 * resets its configuration (panel/logs channel, message ID, developer role)
 * back to unconfigured.
 */

import { SlashCommandBuilder } from "discord.js";
import { denyIfNotOwner } from "./permissions.js";
import { bugReportDB } from "../bugreport/bugReportDB.js";
import { logger } from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("delcbug")
  .setDescription("Hapus panel dan konfigurasi Report Center / Bug & Feature (Owner only)");

export async function execute(interaction) {
  if (await denyIfNotOwner(interaction)) return;

  await interaction.deferReply({ ephemeral: true });

  const cfg = bugReportDB.getConfig();

  if (cfg.panelChannelId && cfg.panelMessageId) {
    try {
      const ch  = await interaction.client.channels.fetch(cfg.panelChannelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(cfg.panelMessageId).catch(() => null) : null;
      if (msg) await msg.delete().catch(() => {});
    } catch (e) {
      logger.warn(`[BugReport] Gagal menghapus panel message: ${e.message}`);
    }
  }

  bugReportDB.resetConfig();
  logger.info(`[BugReport] Report Center dihapus oleh ${interaction.user.id}`);

  await interaction.editReply({ content: "✅ Report Center berhasil dihapus." });
}
