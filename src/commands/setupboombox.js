/**
 * commands/setupboombox.js — /setupboombox slash command.
 *
 * Panel terpusat untuk seluruh konfigurasi BoomBox V2.
 * Hanya Owner yang dapat menggunakan command ini.
 *
 * Jika konfigurasi sudah ada → tampilkan panel "Sudah Dikonfigurasi"
 * dengan tombol Edit / Hapus / Tutup.
 * Jika belum ada → tampilkan wizard setup.
 */

import { SlashCommandBuilder } from "discord.js";
import { denyIfNotOwner }      from "../middleware/permissions.js";
import { db }                  from "../database/db.js";
import {
  buildConfiguredBoomBoxPanel,
  buildSetupBoomBoxPanel,
} from "../features/boombox/setup/panel.js";

export const data = new SlashCommandBuilder()
  .setName("setupboombox")
  .setDescription("Buka panel konfigurasi BoomBox V2");

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (await denyIfNotOwner(interaction)) return;

  const panel = db.isConfigured()
    ? buildConfiguredBoomBoxPanel()
    : buildSetupBoomBoxPanel();

  await interaction.reply({
    embeds:    [panel.embed],
    components: panel.components,
    ephemeral: true,
  });
}
