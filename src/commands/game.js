/**
 * /game — Game feature via Kyzz API (game3rb).
 */

import { SlashCommandBuilder } from "discord.js";
import { handleGameCommand }   from "../features/kyzz/gameHandler.js";

export const data = new SlashCommandBuilder()
  .setName("game")
  .setDescription("🎮 Cari & lihat info game dari Game3rb")
  .addSubcommand(sub => sub.setName("home").setDescription("🏠 Game terbaru di Game3rb"))
  .addSubcommand(sub => sub.setName("popular").setDescription("🔥 Game populer"))
  .addSubcommand(sub =>
    sub.setName("search")
      .setDescription("🔍 Cari game")
      .addStringOption(opt => opt.setName("query").setDescription("Nama game").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("category")
      .setDescription("📂 Game berdasarkan kategori")
      .addStringOption(opt => opt.setName("category").setDescription("Kategori game").setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName("detail")
      .setDescription("📋 Detail game")
      .addStringOption(opt => opt.setName("game").setDescription("Nama game").setRequired(true))
  );

export async function execute(interaction) {
  await handleGameCommand(interaction);
}
