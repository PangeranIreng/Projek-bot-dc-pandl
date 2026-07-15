/**
 * commands/index.js — Slash command registry.
 *
 * Every file in this directory (other than this one and deploy.js) that
 * exports `{ data, execute }` is automatically picked up here -- adding a
 * new slash command means dropping a new file in this folder, nothing
 * else. Both the Discord registration step (deploy.js) and the
 * interactionCreate dispatcher (index.js) read from this single Map so
 * they can never drift out of sync with each other.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXCLUDED_FILES = new Set(["index.js", "deploy.js", "permissions.js"]);

/**
 * Loads every command module in this directory.
 * @returns {Promise<Map<string, { data: import("discord.js").SlashCommandBuilder, execute: Function }>>}
 */
export async function loadCommands() {
  const commands = new Map();
  const files = fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith(".js") && !EXCLUDED_FILES.has(file));

  for (const file of files) {
    const modulePath = pathToFileURL(path.join(__dirname, file)).href;
    const mod = await import(modulePath);

    if (!mod.data || !mod.execute) {
      logger.warn(`[Commands] Melewati ${file} -- tidak mengekspor "data" dan "execute"`);
      continue;
    }

    commands.set(mod.data.name, mod);
  }

  return commands;
}
