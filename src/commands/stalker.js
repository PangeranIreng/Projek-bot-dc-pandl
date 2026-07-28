/**
 * /stalker — Stalker features via Kyzz API.
 */

import { SlashCommandBuilder } from "discord.js";
import { handleStalkerCommand } from "../features/kyzz/stalkerHandler.js";

export const data = new SlashCommandBuilder()
  .setName("stalker")
  .setDescription("🔎 Stalker member JKT48 atau profil TikTok")
  .addSubcommand(sub =>
    sub.setName("jkt")
      .setDescription("🌸 Stalker member JKT48")
      .addStringOption(opt =>
        opt.setName("member")
          .setDescription("Nama member JKT48")
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("tiktok")
      .setDescription("🎵 Stalker profil TikTok")
      .addStringOption(opt =>
        opt.setName("username")
          .setDescription("Username TikTok (tanpa @)")
          .setRequired(true)
      )
  );

export async function execute(interaction) {
  await handleStalkerCommand(interaction);
}
