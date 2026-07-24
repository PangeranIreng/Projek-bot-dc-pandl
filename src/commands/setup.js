/**
 * commands/setup.js — /setup slash command (Panel Admin Terpusat).
 *
 * Menggantikan: /setup (Database), /setupboombox, /setupluatools,
 *               /cticket, /cbug, /delcbug, /delcticket, /setclaimticket, /premstats
 *
 * Semua konfigurasi bot ada di satu command ini.
 * Hanya bisa digunakan oleh Owner / Developer.
 */

import { SlashCommandBuilder } from "discord.js";
import { denyIfNotStaff }      from "../middleware/permissions.js";
import { buildMainSetupEmbed, buildMainSetupComponents } from "../features/setup/adminSetup.js";

export const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Buka Panel Admin untuk mengatur seluruh konfigurasi bot (Owner/Developer only)");

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  await interaction.reply({
    embeds:     [buildMainSetupEmbed()],
    components: buildMainSetupComponents(),
    ephemeral:  true,
  });
}
