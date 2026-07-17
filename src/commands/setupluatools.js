/**
 * commands/setupluatools.js — /setupluatools slash command.
 *
 * Panel terpusat untuk seluruh konfigurasi Lua Tools.
 * Hanya Owner dan Developer yang dapat menggunakan command ini.
 */

import { SlashCommandBuilder } from "discord.js";
import { denyIfNotStaff }      from "../middleware/permissions.js";
import { ltDB }                from "../database/db.js";
import {
  buildLuaToolsConfiguredPanel,
  buildLuaToolsSetupPanel,
} from "../features/luatools/setup/panel.js";

export const data = new SlashCommandBuilder()
  .setName("setupluatools")
  .setDescription("Buka panel konfigurasi Lua Tools");

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  const panel = ltDB.isAnyConfigured()
    ? buildLuaToolsConfiguredPanel()
    : buildLuaToolsSetupPanel();

  await interaction.reply({
    embeds:    [panel.embed],
    components: panel.components,
    ephemeral: true,
  });
}
