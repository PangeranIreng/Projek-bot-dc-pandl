/**
 * /image — Image feature via Kyzz API.
 */

import { SlashCommandBuilder } from "discord.js";
import { handleImageCommand }  from "../features/kyzz/imageHandler.js";

export const data = new SlashCommandBuilder()
  .setName("image")
  .setDescription("🖼️ Ambil gambar random dari berbagai kategori")
  .addSubcommand(sub => sub.setName("random").setDescription("🎲 Gambar random"))
  .addSubcommand(sub => sub.setName("animehot").setDescription("🔥 Anime hot image"))
  .addSubcommand(sub => sub.setName("cosplay").setDescription("💃 Cosplay image"))
  .addSubcommand(sub => sub.setName("husbu").setDescription("💙 Husbu image"))
  .addSubcommand(sub => sub.setName("shota").setDescription("✨ Shota image"));

export async function execute(interaction) {
  await handleImageCommand(interaction);
}
