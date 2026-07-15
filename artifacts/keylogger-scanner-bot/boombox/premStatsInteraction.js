/**
 * premStatsInteraction.js — handles "ps:" button interactions for the
 * Premium Statistics dashboard.
 *
 *   ps:refresh → Owner/Developer only; recalculates and edits the panel in-place.
 */

import { updatePremStatsDashboard } from "./premStatsDashboard.js";
import { isStaff } from "../commands/permissions.js";
import { logger } from "../utils/logger.js";

/**
 * Route and handle all ps:* interactions.
 * @param {import("discord.js").Interaction} interaction
 * @param {import("discord.js").Client}      client
 */
export async function handlePremStatsInteraction(interaction, client) {
  const id = interaction.customId ?? "";

  try {
    if (id === "ps:refresh") {
      if (!isStaff(interaction.member)) {
        await interaction.reply({
          content: "❌ Hanya Owner/Developer yang dapat melakukan refresh.",
          ephemeral: true,
        });
        return;
      }
      // Acknowledge immediately so Discord doesn't mark the interaction as failed.
      await interaction.deferUpdate();
      await updatePremStatsDashboard(client);
      return;
    }
  } catch (e) {
    logger.error(`[PremStats] Interaction error for "${id}": ${e.message}`);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Terjadi kesalahan.", ephemeral: true }).catch(() => {});
    }
  }
}
