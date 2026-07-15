/**
 * bugReportHandler.js — Core Bug Report / Feature Request logic.
 *
 * Deliberately does NOT create threads, tickets, or channels — this is a
 * lightweight report-in/report-out system: panel button → modal → logs
 * channel + ephemeral thank-you. Nothing else.
 */

import { bugReportDB } from "./bugReportDB.js";
import {
  buildBugPanelEmbed,
  buildBugPanelButtonRow,
  buildBugReportModal,
  buildFeatureRequestModal,
  buildBugLogEmbed,
  buildFeatureLogEmbed,
  buildThankYouEmbed,
  buildDismissButtonRow,
} from "./bugReportEmbed.js";
import { logger } from "../utils/logger.js";
import { logError } from "../utils/errorLogger.js";

/** Send the "Bug & Feature" panel to a channel. Returns the sent message. */
export async function sendBugPanel(channel) {
  return channel.send({ embeds: [buildBugPanelEmbed()], components: [buildBugPanelButtonRow()] });
}

/** Panel button clicked — open the matching modal. No DB write happens yet. */
export async function openReportModal(interaction, kind) {
  const modal = kind === "report" ? buildBugReportModal() : buildFeatureRequestModal();
  await interaction.showModal(modal);
}

/** Modal submitted — log to logs_channel (mentioning the developer role) and
 * send an ephemeral thank-you. Never posts anything to a public channel. */
export async function handleReportSubmit(interaction, kind) {
  const config = bugReportDB.getConfig();
  if (!config.logsChannelId) {
    await interaction.reply({
      content: "❌ Sistem Bug & Feature belum dikonfigurasi. Hubungi Owner.",
      ephemeral: true,
    });
    return;
  }

  const title = interaction.fields.getTextInputValue("title").trim();
  const desc  = interaction.fields.getTextInputValue("desc").trim();

  const logsChannel = await interaction.client.channels.fetch(config.logsChannelId).catch(() => null);
  if (!logsChannel?.isTextBased()) {
    logger.warn(`[BugReport] Logs channel ${config.logsChannelId} not found or not text-based`);
    await logError({
      feature: "Bug & Feature",
      reason:  `Logs channel ${config.logsChannelId} tidak ditemukan atau bukan text channel`,
      stage:   "Submit Report",
      user:    interaction.user.id,
    }).catch(() => {});
    await interaction.reply({ content: "❌ Gagal mengirim laporan. Hubungi Owner.", ephemeral: true });
    return;
  }

  const embed = kind === "report"
    ? buildBugLogEmbed({ title, desc, userId: interaction.user.id })
    : buildFeatureLogEmbed({ title, desc, userId: interaction.user.id });

  const mention = config.developerRoleId ? `<@&${config.developerRoleId}>` : "";

  try {
    await logsChannel.send({ content: mention || undefined, embeds: [embed] });
  } catch (e) {
    logger.error(`[BugReport] Gagal mengirim log ke channel: ${e.message}`);
    await logError({
      feature: "Bug & Feature",
      reason:  e.message,
      stage:   "Submit Report",
      user:    interaction.user.id,
      error:   e,
    }).catch(() => {});
    await interaction.reply({ content: "❌ Gagal mengirim laporan. Hubungi Owner.", ephemeral: true });
    return;
  }

  await interaction.reply({
    embeds:     [buildThankYouEmbed(kind)],
    components: [buildDismissButtonRow()],
    ephemeral:  true,
  });
}

/** Dismiss button on the ephemeral thank-you message. */
export async function handleDismiss(interaction) {
  await interaction.deferUpdate();
  await interaction.deleteReply().catch(() => {});
}
