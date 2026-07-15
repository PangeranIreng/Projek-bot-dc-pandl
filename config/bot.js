/**
 * config/bot.js — Dynamic secret loading (BOT_TOKEN, SCAN_CHANNEL_ID).
 * Re-reads env on every call so values written by the setup page after
 * process start are picked up without a restart.
 */

import "dotenv/config";
import { parse as parseEnv } from "dotenv";
import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KEYLOGGER_SCAN_CHANNEL_ID } from "./channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH  = path.join(__dirname, "..", ".env");

/**
 * @returns {{ botToken, scanChannelId, isConfigured, missingSecrets }}
 */
export function getSecretsConfig() {
  let fileValues = {};
  if (fs.existsSync(ENV_PATH)) {
    try { fileValues = parseEnv(fs.readFileSync(ENV_PATH, "utf8")); } catch { /* ignore */ }
  }

  const botToken     = process.env.BOT_TOKEN      || fileValues.BOT_TOKEN      || "";
  const scanChannelId= process.env.SCAN_CHANNEL_ID|| fileValues.SCAN_CHANNEL_ID|| KEYLOGGER_SCAN_CHANNEL_ID || "";

  const missingSecrets = [];
  if (!botToken)      missingSecrets.push("BOT_TOKEN");
  if (!scanChannelId) missingSecrets.push("SCAN_CHANNEL_ID");

  return { botToken, scanChannelId, isConfigured: missingSecrets.length === 0, missingSecrets };
}
