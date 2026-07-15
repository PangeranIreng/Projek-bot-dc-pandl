/**
 * commands/cbug.js — /cbug [panel_channel] [logs_channel] [developer_role]
 *
 * Owner-only. Configures the Bug Report & Feature Request system: where
 * the panel lives, where reports get logged, and which role gets mentioned
 * on new reports. Re-running with panel_channel edits the existing panel
 * message instead of spamming a new one.
 */

import { SlashCommandBuilder, ChannelType } from "discord.js";
import { denyIfNotOwner } from "./permissions.js";
import { bugReportDB } from "../bugreport/bugReportDB.js";
import { sendBugPanel } from "../bugreport/bugReportHandler.js";
import { buildBugPanelEmbed, buildBugPanelButtonRow } from "../bugreport/bugReportEmbed.js";
import { logger } from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("cbug")
  .setDescription("Konfigurasi sistem Bug Report & Feature Request")
  .addChannelOption((opt) =>
    opt
      .setName("panel_channel")
      .setDescription("Channel tempat Panel Bug & Feature dikirim")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false),
  )
  .addChannelOption((opt) =>
    opt
      .setName("logs_channel")
      .setDescription("Channel tempat semua laporan Bug & Feature masuk")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false),
  )
  .addRoleOption((opt) =>
    opt
      .setName("developer_role")
      .setDescription("Role yang otomatis di-mention ketika ada laporan baru")
      .setRequired(false),
  );

export async function execute(interaction) {
  if (await denyIfNotOwner(interaction)) return;

  const panelChannel   = interaction.options.getChannel("panel_channel");
  const logsChannel    = interaction.options.getChannel("logs_channel");
  const developerRole  = interaction.options.getRole("developer_role");

  if (!panelChannel && !logsChannel && !developerRole) {
    const cfg = bugReportDB.getConfig();
    await interaction.reply({
      content: [
        "ℹ️ **Konfigurasi Bug & Feature saat ini:**",
        `• Panel Channel : ${cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : "belum diatur"}`,
        `• Logs Channel : ${cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : "belum diatur"}`,
        `• Developer Role : ${cfg.developerRoleId ? `<@&${cfg.developerRoleId}>` : "belum diatur"}`,
        "",
        "Gunakan opsi `panel_channel`, `logs_channel`, dan/atau `developer_role` untuk mengubahnya.",
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const patch = {};
  if (panelChannel)  patch.panelChannelId  = panelChannel.id;
  if (logsChannel)   patch.logsChannelId   = logsChannel.id;
  if (developerRole) patch.developerRoleId = developerRole.id;
  bugReportDB.setConfig(patch);

  const notes = [];

  if (panelChannel) {
    try {
      const cfg = bugReportDB.getConfig();
      let edited = false;
      if (cfg.panelMessageId) {
        const oldMsg = await panelChannel.messages.fetch(cfg.panelMessageId).catch(() => null);
        if (oldMsg) {
          await oldMsg.edit({ embeds: [buildBugPanelEmbed()], components: [buildBugPanelButtonRow()] });
          edited = true;
        }
      }
      if (!edited) {
        const panelMsg = await sendBugPanel(panelChannel);
        bugReportDB.setConfig({ panelMessageId: panelMsg.id });
      }
      notes.push(`✅ Panel Bug & Feature ${edited ? "diperbarui" : "dikirim"} di ${panelChannel}`);
    } catch (e) {
      logger.error(`[BugReport] Gagal mengirim/mengedit panel: ${e.message}`);
      notes.push(`⚠️ Gagal mengirim panel ke ${panelChannel}: ${e.message}`);
    }
  }

  if (logsChannel) {
    notes.push(`✅ Logs Bug & Feature diatur ke ${logsChannel}`);
  }

  if (developerRole) {
    notes.push(`✅ Developer role diatur ke ${developerRole}`);
  }

  await interaction.editReply({ content: notes.join("\n") || "✅ Konfigurasi diperbarui." });
}
