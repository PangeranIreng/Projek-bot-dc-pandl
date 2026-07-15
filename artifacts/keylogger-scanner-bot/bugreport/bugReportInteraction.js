/**
 * bugReportInteraction.js — Handles all Discord interactions whose
 * customId starts with "bug:" (panel buttons, modal submits, dismiss).
 *
 *   bug:panel:report   (button)       → open Report Bug modal
 *   bug:panel:feature  (button)       → open Request Feature modal
 *   bug:modal:report   (modal submit) → log + ephemeral thank-you
 *   bug:modal:feature  (modal submit) → log + ephemeral thank-you
 *   bug:dismiss        (button)       → delete the ephemeral thank-you
 */

import { openReportModal, handleReportSubmit, handleDismiss } from "./bugReportHandler.js";
import { logger } from "../utils/logger.js";

export async function handleBugReportInteraction(interaction) {
  const id = interaction.customId ?? "";

  try {
    if (id === "bug:panel:report") {
      await openReportModal(interaction, "report");
      return;
    }
    if (id === "bug:panel:feature") {
      await openReportModal(interaction, "feature");
      return;
    }
    if (id === "bug:modal:report") {
      await handleReportSubmit(interaction, "report");
      return;
    }
    if (id === "bug:modal:feature") {
      await handleReportSubmit(interaction, "feature");
      return;
    }
    if (id === "bug:dismiss") {
      await handleDismiss(interaction);
      return;
    }
  } catch (e) {
    logger.error(`[BugReport] Interaction error for "${id}": ${e.message}`);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Terjadi kesalahan pada sistem Bug & Feature.", ephemeral: true }).catch(() => {});
    }
  }
}
