/**
 * commands/premstats.js — /premstats <channel>
 *
 * Owner/Developer only.
 *
 * First run:
 *   1. Scans the chosen channel for old "👑 Premium Monitoring" embeds sent
 *      by this bot and deletes them (only those — nothing else is touched).
 *   2. Creates a fresh "👑 Premium Statistics" panel in that channel.
 *
 * Subsequent updates:
 *   The panel is always edited in-place. No new messages are ever sent unless
 *   the original was deleted (in which case it is recreated automatically).
 */

import { ChannelType, SlashCommandBuilder } from "discord.js";
import { denyIfNotStaff } from "./permissions.js";
import { premDB } from "../boombox/db.js";
import { updatePremStatsDashboard } from "../boombox/premStatsDashboard.js";
import { logger } from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("premstats")
  .setDescription("Buat panel Premium Statistics di channel yang dipilih. Owner/Developer only.")
  .addChannelOption((opt) =>
    opt
      .setName("channel")
      .setDescription("Channel tempat panel Premium Statistics dibuat")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true),
  );

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.options.getChannel("channel", true);

  // ── Step 1: Delete old "👑 Premium Monitoring" embeds by this bot ─────────
  // Only the bot's own messages, only those containing the old "Premium
  // Monitoring" title. BoomBox Logs, Ticket panels, Scanner Logs, Premium
  // Logs, and all user chat are left completely untouched.
  let deletedOld = 0;
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    for (const [, msg] of messages) {
      if (msg.author.id !== interaction.client.user.id) continue; // not the bot
      const hasOldMonitoringEmbed = msg.embeds.some((e) =>
        typeof e.title === "string" && e.title.includes("Premium Monitoring"),
      );
      if (!hasOldMonitoringEmbed) continue;
      await msg.delete().catch(() => {});
      deletedOld++;
      logger.info(`[premstats] Deleted old Premium Monitoring embed ${msg.id}`);
    }
  } catch (e) {
    logger.warn(`[premstats] Could not scan for old embeds: ${e.message}`);
  }

  // ── Step 2: Point the dashboard at the new channel ────────────────────────
  // Clear the stored message ID so updatePremStatsDashboard sends a fresh one.
  premDB.setPremStatsDashboardState({ channelId: channel.id, messageId: null });

  // ── Step 3: Create the new panel ─────────────────────────────────────────
  await updatePremStatsDashboard(interaction.client);

  const note = deletedOld > 0
    ? `\n🗑️ ${deletedOld} panel **Premium Monitoring** lama berhasil dihapus.`
    : "";

  await interaction.editReply({
    content:
      `✅ Panel **Premium Statistics** berhasil dibuat di ${channel}.${note}\n\n` +
      `Panel akan otomatis diperbarui setiap ada perubahan premium — tidak perlu command ulang.`,
  });
}
