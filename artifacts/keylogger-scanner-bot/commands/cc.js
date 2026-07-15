/**
 * commands/cc.js — /cc <jumlah>
 *
 * Hapus N pesan terakhir dari channel saat ini.
 * Owner/Developer only. Menerima jumlah berapa pun — iterasi batch 100
 * sesuai batas Discord API hingga jumlah tercapai atau chat habis.
 */

import { SlashCommandBuilder } from "discord.js";
import { denyIfNotStaff } from "./permissions.js";
import { logger } from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("cc")
  .setDescription("Hapus pesan di channel ini (Owner/Developer only)")
  .addIntegerOption((opt) =>
    opt
      .setName("jumlah")
      .setDescription("Jumlah pesan yang akan dihapus")
      .setMinValue(1)
      .setRequired(true),
  );

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  const jumlah = interaction.options.getInteger("jumlah", true);

  await interaction.deferReply({ ephemeral: true });

  try {
    const channel = interaction.channel;
    if (!channel?.isTextBased()) {
      await interaction.editReply({ content: "❌ Command ini hanya bisa digunakan di channel teks." });
      return;
    }

    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000; // 14 days ago
    let deleted  = 0;
    let remaining = jumlah;
    let lastId   = undefined;
    let lastProgressUpdate = Date.now();

    while (remaining > 0) {
      // Discord API: max 100 messages per fetch
      const fetchLimit = Math.min(remaining, 100);
      const fetchOpts  = { limit: fetchLimit };
      if (lastId) fetchOpts.before = lastId;

      const fetched = await channel.messages.fetch(fetchOpts);
      if (fetched.size === 0) break;

      // Track the oldest message ID for next-page pagination
      lastId = fetched.last()?.id;

      const bulk = fetched.filter((m) => m.createdTimestamp > cutoff);
      const old  = fetched.filter((m) => m.createdTimestamp <= cutoff);

      // Bulk delete recent messages (up to 100, Discord limit)
      if (bulk.size >= 2) {
        await channel.bulkDelete(bulk, true);
        deleted += bulk.size;
      } else if (bulk.size === 1) {
        await bulk.first().delete().catch(() => {});
        deleted += 1;
      }

      // Delete older messages one by one (rate-limited path)
      for (const msg of old.values()) {
        await msg.delete().catch(() => {});
        deleted++;
        await new Promise((r) => setTimeout(r, 400));
      }

      remaining -= fetched.size;

      // Update progress every ~5 seconds so the interaction doesn't timeout
      // for very large deletions, and so the user knows we're still working.
      if (remaining > 0 && Date.now() - lastProgressUpdate > 5000) {
        await interaction.editReply({
          content: `⏳ Menghapus pesan... **${deleted}** sudah dihapus, **${remaining}** tersisa.`,
        }).catch(() => {});
        lastProgressUpdate = Date.now();
      }

      // Short pause between batches to respect Discord rate limits on bulkDelete
      if (remaining > 0 && fetched.size === fetchLimit) {
        await new Promise((r) => setTimeout(r, 1200));
      }

      // No more messages available
      if (fetched.size < fetchLimit) break;
    }

    await interaction.editReply({
      content: `✅ Berhasil menghapus **${deleted}** pesan dari ${channel}.`,
    });
    logger.info(`[CC] ${interaction.user.tag} menghapus ${deleted} pesan di #${channel.name}`);
  } catch (e) {
    logger.error(`[CC] Error: ${e.message}`);
    await interaction.editReply({
      content: `❌ Gagal menghapus pesan: ${e.message.slice(0, 200)}`,
    }).catch(() => {});
  }
}
