/**
 * commands/cticket.js — /cticket [panel_channel] [logs_channel] [mention_role]
 *
 * Configures the Ticket system. All options are individually optional so
 * staff can update one setting at a time; config is stored in ticketDB and
 * survives restarts. Providing panel_channel (re)sends the Open Ticket
 * panel there (replacing the previous panel message if still trackable).
 * Providing logs_channel creates/refreshes the Ticket Logs dashboard.
 */

import { SlashCommandBuilder, ChannelType } from "discord.js";
import { denyIfNotStaff } from "./permissions.js";
import { ticketDB } from "../ticket/ticketDB.js";
import { sendTicketPanel } from "../ticket/ticketHandler.js";
import { updateTicketDashboard } from "../ticket/ticketDashboard.js";
import { logger } from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("cticket")
  .setDescription("Konfigurasi sistem Open Ticket")
  .addChannelOption((opt) =>
    opt
      .setName("panel_channel")
      .setDescription("Channel tempat panel Open Ticket dikirim")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false),
  )
  .addChannelOption((opt) =>
    opt
      .setName("logs_channel")
      .setDescription("Channel Dashboard Ticket Logs")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false),
  )
  .addRoleOption((opt) =>
    opt
      .setName("mention_role")
      .setDescription("Role yang di-mention saat Ticket baru dibuat")
      .setRequired(false),
  );

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  const panelChannel = interaction.options.getChannel("panel_channel");
  const logsChannel  = interaction.options.getChannel("logs_channel");
  const mentionRole  = interaction.options.getRole("mention_role");

  if (!panelChannel && !logsChannel && !mentionRole) {
    const cfg = ticketDB.getConfig();
    await interaction.reply({
      content: [
        "ℹ️ **Konfigurasi Ticket saat ini:**",
        `• Panel Channel : ${cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : "belum diatur"}`,
        `• Logs Channel : ${cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : "belum diatur"}`,
        `• Mention Role : ${cfg.mentionRoleId ? `<@&${cfg.mentionRoleId}>` : "belum diatur"}`,
        "",
        "Gunakan opsi `panel_channel`, `logs_channel`, dan/atau `mention_role` untuk mengubahnya.",
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const patch = {};
  if (panelChannel) patch.panelChannelId = panelChannel.id;
  if (logsChannel)  patch.logsChannelId  = logsChannel.id;
  if (mentionRole)  patch.mentionRoleId  = mentionRole.id;
  ticketDB.setConfig(patch);

  const notes = [];

  if (panelChannel) {
    try {
      const cfg = ticketDB.getConfig();
      if (cfg.panelMessageId) {
        const oldMsg = await panelChannel.messages.fetch(cfg.panelMessageId).catch(() => null);
        if (oldMsg) await oldMsg.delete().catch(() => {});
      }
      const panelMsg = await sendTicketPanel(panelChannel);
      ticketDB.setConfig({ panelMessageId: panelMsg.id });
      notes.push(`✅ Panel Open Ticket dikirim ke ${panelChannel}`);
    } catch (e) {
      logger.error(`[Ticket] Gagal mengirim panel: ${e.message}`);
      notes.push(`⚠️ Gagal mengirim panel ke ${panelChannel}: ${e.message}`);
    }
  }

  if (logsChannel) {
    await updateTicketDashboard(interaction.client).catch(() => {});
    notes.push(`✅ Dashboard Ticket Logs diatur ke ${logsChannel}`);
  }

  if (mentionRole) {
    notes.push(`✅ Mention role diatur ke ${mentionRole}`);
  }

  await interaction.editReply({ content: notes.join("\n") || "✅ Konfigurasi diperbarui." });
}
