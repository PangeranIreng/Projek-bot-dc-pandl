/**
 * /tools — Utility tools via Kyzz API.
 */

import { SlashCommandBuilder } from "discord.js";
import { handleToolsCommand }  from "../features/kyzz/toolsHandler.js";

export const data = new SlashCommandBuilder()
  .setName("tools")
  .setDescription("🛠️ Tools berguna via Kyzz API")
  .addSubcommand(sub =>
    sub.setName("compare")
      .setDescription("📱 Bandingkan dua smartphone")
      .addStringOption(opt => opt.setName("device1").setDescription("Nama HP pertama (contoh: iPhone 15)").setRequired(true))
      .addStringOption(opt => opt.setName("device2").setDescription("Nama HP kedua (contoh: Samsung S24)").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("upscale")
      .setDescription("✨ Upscale kualitas video")
      .addStringOption(opt => opt.setName("url").setDescription("URL video yang ingin di-upscale").setRequired(true))
  );

export async function execute(interaction) {
  await handleToolsCommand(interaction);
}
