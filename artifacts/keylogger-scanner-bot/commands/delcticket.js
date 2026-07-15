/**
 * commands/delcticket.js — /delcticket
 *
 * Owner-only. Removes the Ticket system's panel + dashboard messages and
 * resets its configuration (panel/logs channel, message IDs, mention role)
 * back to unconfigured. Ticket history (`tickets`/`counter`) is left
 * untouched — only panel/dashboard/config, per spec.
 */

import { SlashCommandBuilder } from "discord.js";
import { denyIfNotOwner } from "./permissions.js";
import { ticketDB } from "../ticket/ticketDB.js";
import { logger } from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("delcticket")
  .setDescription("Hapus panel, dashboard, dan konfigurasi sistem Ticket (Owner only)");

export async function execute(interaction) {
  if (await denyIfNotOwner(interaction)) return;

  await interaction.deferReply({ ephemeral: true });

  const cfg = ticketDB.getConfig();

  // Best-effort cleanup of the live Discord messages — a missing channel or
  // already-deleted message must never block the DB reset below.
  if (cfg.panelChannelId && cfg.panelMessageId) {
    try {
      const ch  = await interaction.client.channels.fetch(cfg.panelChannelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(cfg.panelMessageId).catch(() => null) : null;
      if (msg) await msg.delete().catch(() => {});
    } catch (e) {
      logger.warn(`[Ticket] Gagal menghapus panel message: ${e.message}`);
    }
  }

  if (cfg.logsChannelId && cfg.dashboardMessageId) {
    try {
      const ch  = await interaction.client.channels.fetch(cfg.logsChannelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(cfg.dashboardMessageId).catch(() => null) : null;
      if (msg) await msg.delete().catch(() => {});
    } catch (e) {
      logger.warn(`[Ticket] Gagal menghapus dashboard message: ${e.message}`);
    }
  }

  ticketDB.resetConfig();
  logger.info(`[Ticket] Ticket System dihapus oleh ${interaction.user.id}`);

  await interaction.editReply({ content: "✅ Ticket System berhasil dihapus." });
}
