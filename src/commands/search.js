/**
 * /search — Multi-category search via Kyzz API.
 */

import { SlashCommandBuilder } from "discord.js";
import { handleSearchCommand } from "../features/kyzz/searchHandler.js";

export const data = new SlashCommandBuilder()
  .setName("search")
  .setDescription("🔍 Cari berbagai konten via Kyzz API")
  .addSubcommand(sub =>
    sub.setName("youtube")
      .setDescription("🔴 Cari video YouTube")
      .addStringOption(opt => opt.setName("query").setDescription("Kata kunci pencarian").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("anime")
      .setDescription("🎬 Cari Drama / Anime / Film")
      .addStringOption(opt => opt.setName("query").setDescription("Judul anime/drama/film").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("prompt")
      .setDescription("🤖 Cari Prompt AI")
      .addStringOption(opt => opt.setName("query").setDescription("Kata kunci prompt").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("sekolah")
      .setDescription("📚 Cari materi sekolah")
      .addStringOption(opt => opt.setName("query").setDescription("Topik pelajaran").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("discord")
      .setDescription("💬 Cari server Discord")
      .addStringOption(opt => opt.setName("query").setDescription("Nama atau topik server").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("sticker")
      .setDescription("🎨 Cari sticker pack WhatsApp")
      .addStringOption(opt => opt.setName("query").setDescription("Nama sticker pack").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("app")
      .setDescription("📱 Cari aplikasi Android (Uptodown)")
      .addStringOption(opt => opt.setName("query").setDescription("Nama aplikasi").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("wagroup")
      .setDescription("💚 Cari grup WhatsApp")
      .addStringOption(opt => opt.setName("query").setDescription("Nama atau topik grup").setRequired(true))
  );

export async function execute(interaction) {
  await handleSearchCommand(interaction);
}
