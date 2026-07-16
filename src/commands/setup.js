/**
 * commands/setup.js — /setup slash command.
 *
 * Menampilkan menu admin (ephemeral) dengan pilihan:
 *   📊 Database  — Setup panel DATABASE
 *   ❌ Tutup     — Tutup menu
 *
 * Seluruh logika setup ada di src/features/database/interaction.js
 * yang menangani interaksi lanjutan dengan prefix "db:".
 *
 * Hanya bisa digunakan oleh Owner / Developer.
 */

import { SlashCommandBuilder } from "discord.js";
import { denyIfNotStaff }      from "../middleware/permissions.js";
import {
  buildSetupMainEmbed,
  buildSetupMainComponents,
} from "../features/database/embed.js";

export const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Buka menu admin untuk mengatur panel Database dan sistem bot");

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  // Hanya Owner / Developer yang dapat menggunakan command ini
  if (await denyIfNotStaff(interaction)) return;

  await interaction.reply({
    embeds:     [buildSetupMainEmbed()],
    components: buildSetupMainComponents(),
    ephemeral:  true,
  });
}
