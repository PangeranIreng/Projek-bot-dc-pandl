/**
 * src/events/interactionCreate.js — interactionCreate event handler.
 * Routes buttons, selects, modals, and slash commands to their feature handlers.
 *
 * Interaction prefix routing:
 *   ps:       Premium Stats dashboard (replaces the retired "mon:" monitoring
 *             panel -- old "mon:" buttons on pre-existing messages no longer
 *             respond; delete that message and use /premstats instead)
 *   ticket:   Ticket system
 *   bug:      Bug Report system
 *   bm:       BoomBox queue controls
 *   bblog:    BoomBox Log dashboard
 *   sk:       Scanner (scan again, full preview, etc.)
 *   cp:       CPanel role-button panels
 *   help:     Help command category select
 */

import { logger }                   from "../utils/logger.js";
import { logError }                 from "../utils/errorLogger.js";
import { handlePremStatsInteraction }   from "../features/premium/statsInteraction.js";
import { handleTicketInteraction }      from "../features/ticket/interaction.js";
import { handleBugReportInteraction }   from "../features/bugreport/interaction.js";
import { handleBoomBoxInteraction }     from "../features/boombox/interaction.js";
import { handleBoomBoxLogInteraction }  from "../features/logs/logInteraction.js";
import { handleScanButtonInteraction }  from "../handlers/scanInteractionHandler.js";
import { handleCpanelInteraction }      from "../features/setup/cpanel/interaction.js";
import { handleHelpInteraction }        from "../features/help/handler.js";

/**
 * @param {import("discord.js").Interaction} interaction
 * @param {Map<string,any>} commands   Loaded slash command map
 * @param {import("discord.js").Client} client
 */
export async function handleInteractionCreate(interaction, commands, client) {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) {
        logger.warn(`Slash command tidak dikenal: /${interaction.commandName}`);
        await interaction.reply({ content: "❌ Perintah tidak dikenal.", ephemeral: true }).catch(() => {});
        return;
      }
      await command.execute(interaction, { commands });
      return;
    }

    const isBtn    = interaction.isButton();
    const isSelect = interaction.isStringSelectMenu();
    const isModal  = interaction.isModalSubmit();
    if (!isBtn && !isSelect && !isModal) return;

    const id = interaction.customId ?? "";

    if (id.startsWith("ps:")) {
      await handlePremStatsInteraction(interaction, client);
    } else if (id.startsWith("ticket:")) {
      await handleTicketInteraction(interaction);
    } else if (id.startsWith("bug:")) {
      await handleBugReportInteraction(interaction);
    } else if (isBtn && id.startsWith("bm:")) {
      await handleBoomBoxInteraction(interaction);
    } else if (id.startsWith("bblog:")) {
      await handleBoomBoxLogInteraction(interaction);
    } else if (isBtn && id.startsWith("sk:")) {
      await handleScanButtonInteraction(interaction);
    } else if (id.startsWith("cp:")) {
      await handleCpanelInteraction(interaction);
    } else if (id === "help:category") {
      await handleHelpInteraction(interaction);
    }

  } catch (err) {
    logger.error("Kesalahan tak terduga saat memproses interaksi", err);
    await logError({
      feature: interaction.isChatInputCommand() ? "Commands" : "Interaction",
      command: interaction.isChatInputCommand()
        ? `/${interaction.commandName}`
        : interaction.customId,
      reason:  err?.message ?? String(err),
      stage:   "interactionCreate",
      user:    interaction.user?.id,
      guild:   interaction.guildId,
      channel: interaction.channelId,
      error:   err,
    }).catch(() => {});
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Terjadi kesalahan saat menjalankan perintah ini.",
        ephemeral: true,
      }).catch(() => {});
    }
  }
}
