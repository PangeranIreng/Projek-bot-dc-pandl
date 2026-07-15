/**
 * boomboxInteraction.js — Handles Discord button interactions for BoomBox.
 *
 * Button custom IDs:
 *   bm:url:<boomboxUrl>   →  Reply ephemerally with the BoomBox URL.
 *   bm:detail:<id>        →  Reply ephemerally with full failure detail.
 */

import { logger } from "../utils/logger.js";
import { getErrorDetail } from "./boomboxErrorStore.js";
import { buildErrorDetailEmbed } from "./boomboxEmbed.js";

/**
 * Handle a Discord button interaction from BoomBox.
 * Call this from the main interactionCreate listener for interactions whose
 * customId starts with "bm:".
 *
 * @param {import("discord.js").ButtonInteraction} interaction
 */
export async function handleBoomBoxInteraction(interaction) {
  if (!interaction.isButton()) return;

  const id = interaction.customId ?? "";

  // ── Show URL ──────────────────────────────────────────────────────────────
  if (id.startsWith("bm:url:")) {
    const boomboxUrl = id.slice("bm:url:".length);

    if (!boomboxUrl) {
      await interaction.reply({
        content: "❌ URL tidak tersedia.",
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    logger.debug(`[BoomBox] Show URL button | url=${boomboxUrl}`);
    await interaction.reply({
      content: `🔗 **BoomBox URL:**\n${boomboxUrl}`,
      ephemeral: true,
    }).catch(err => {
      logger.warn(`[BoomBox] Failed to reply to Show URL: ${err.message}`);
    });
    return;
  }

  // ── Show error detail ─────────────────────────────────────────────────────
  if (id.startsWith("bm:detail:")) {
    const detailId = id.slice("bm:detail:".length);
    const detail = getErrorDetail(detailId);

    if (!detail) {
      await interaction.reply({
        content: "❌ Detail sudah tidak tersedia (kedaluwarsa).",
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    logger.debug(`[BoomBox] Show error detail button | id=${detailId}`);
    await interaction.reply({
      embeds: [buildErrorDetailEmbed(detail)],
      ephemeral: true,
    }).catch(err => {
      logger.warn(`[BoomBox] Failed to reply to Detail button: ${err.message}`);
    });
    return;
  }

  // Unknown bm: prefix — ignore
  logger.debug(`[BoomBox] Unknown interaction customId: ${id}`);
}
