/**
 * commands/setup.js — /setup slash command.
 *
 * Jika setup BELUM ADA → tampilkan Wizard Setup.
 * Jika sudah ada       → tampilkan Database Manager.
 *
 * Seluruh logika setup ada di src/features/database/interaction.js
 * yang menangani interaksi lanjutan dengan prefix "db:".
 *
 * Hanya bisa digunakan oleh Owner / Developer.
 */

import { SlashCommandBuilder } from "discord.js";
import { denyIfNotStaff }      from "../middleware/permissions.js";
import { databaseDB }          from "../database/databaseDB.js";
import {
  buildSetupWizardEmbed,
  buildSetupWizardComponents,
  buildSetupManageEmbed,
  buildSetupManageComponents,
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

  if (databaseDB.isSetup()) {
    // Sudah setup — langsung tampilkan Database Manager
    await interaction.reply({
      embeds:     [buildSetupManageEmbed(databaseDB.get())],
      components: buildSetupManageComponents(),
      ephemeral:  true,
    });
  } else {
    // Belum setup — tampilkan Wizard Setup
    await interaction.reply({
      embeds:     [buildSetupWizardEmbed()],
      components: buildSetupWizardComponents(),
      ephemeral:  true,
    });
  }
}
