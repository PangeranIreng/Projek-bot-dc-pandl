/**
 * /bypass — URL bypass via Kyzz API.
 */

import { SlashCommandBuilder } from "discord.js";
import { handleBypassCommand } from "../features/kyzz/bypassHandler.js";

export const data = new SlashCommandBuilder()
  .setName("bypass")
  .setDescription("🔓 Bypass link shortener / protected URLs")
  .addStringOption(opt =>
    opt.setName("url")
      .setDescription("URL yang ingin di-bypass")
      .setRequired(true)
  );

export async function execute(interaction) {
  await handleBypassCommand(interaction);
}
