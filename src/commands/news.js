/**
 * /news — Berita terkini dari ANTARA via Kyzz API.
 */

import { SlashCommandBuilder } from "discord.js";
import { handleNewsCommand }   from "../features/kyzz/newsHandler.js";

export const data = new SlashCommandBuilder()
  .setName("news")
  .setDescription("📰 Berita terkini dari ANTARA")
  .addStringOption(opt =>
    opt.setName("topic")
      .setDescription("Topik berita (kosongkan untuk semua berita terkini)")
      .setRequired(false)
  );

export async function execute(interaction) {
  await handleNewsCommand(interaction);
}
