/**
 * commands/setupboombox.js — /setupboombox slash command.
 *
 * Panel terpusat untuk seluruh konfigurasi BoomBox V2.
 * Hanya Owner yang dapat menggunakan command ini.
 */

import { SlashCommandBuilder } from "discord.js";
import { denyIfNotOwner }      from "../middleware/permissions.js";
import { buildSetupBoomBoxPanel } from "../features/boombox/setup/panel.js";

export const data = new SlashCommandBuilder()
  .setName("setupboombox")
  .setDescription("Buka panel konfigurasi BoomBox V2");

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (await denyIfNotOwner(interaction)) return;

  const { embed, components } = buildSetupBoomBoxPanel();
  await interaction.reply({
    embeds:    [embed],
    components,
    ephemeral: true,
  });
}
