/**
 * /download — Universal downloader via Kyzz API.
 * Supports YouTube, TikTok, Instagram, Facebook, Twitter/X, Threads,
 * Pinterest, MediaFire, SoundCloud, dan platform lain.
 */

import { SlashCommandBuilder } from "discord.js";
import { handleDownloadCommand } from "../features/kyzz/downloadHandler.js";

export const data = new SlashCommandBuilder()
  .setName("download")
  .setDescription("⬇️ Download media dari berbagai platform (YouTube, TikTok, Instagram, dll.)")
  .addStringOption(opt =>
    opt.setName("url")
      .setDescription("URL media yang ingin didownload")
      .setRequired(true)
  );

export async function execute(interaction) {
  await handleDownloadCommand(interaction);
}
