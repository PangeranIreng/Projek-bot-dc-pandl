/**
 * commands/deploy.js — Registers slash commands with Discord.
 *
 * Registers as GUILD commands (scoped to IDS.GUILD_ID) rather than global
 * commands: guild commands propagate to the Discord "/" menu instantly,
 * while global commands can take up to an hour to show up everywhere.
 * This project only targets a single guild, so there's no downside.
 *
 * Runs automatically on every bot startup (called from index.js's
 * clientReady handler) -- commands stay registered and in sync with the
 * codebase across restarts with zero manual steps.
 */

import { REST, Routes } from "discord.js";
import { IDS } from "../config/ids.js";
import { logger } from "../utils/logger.js";

/**
 * @param {import("discord.js").Client} client Logged-in client (for id/token)
 * @param {Map<string, { data: import("discord.js").SlashCommandBuilder }>} commands
 */
export async function deployCommands(client, commands) {
  const body = [...commands.values()].map((cmd) => cmd.data.toJSON());

  const rest = new REST().setToken(client.token);

  try {
    const result = await rest.put(
      Routes.applicationGuildCommands(client.user.id, IDS.GUILD_ID),
      { body },
    );
    logger.info(`[Commands] ${result.length} slash command berhasil didaftarkan ke guild ${IDS.GUILD_ID}`);
  } catch (err) {
    logger.error("[Commands] Gagal mendaftarkan slash command", err);
    throw err;
  }
}
