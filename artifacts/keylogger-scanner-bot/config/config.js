import "dotenv/config";
import { parse as parseEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IDS } from "./ids.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");

// Static, unrelated to secrets -- safe to read once at import time.
export const config = {
  // Discord's default non-Nitro upload cap. Anything larger is skipped
  // rather than risking a slow/failed download.
  maxAttachmentSizeBytes: 25 * 1024 * 1024,
  // Guard rail for zip bombs / huge archives: total decompressed bytes we
  // are willing to read into memory and scan.
  maxTotalScanBytes: 60 * 1024 * 1024,
  // Per-entry cap inside a zip.
  maxEntrySizeBytes: 15 * 1024 * 1024,
  // Max number of entries inspected inside a single zip.
  maxZipEntries: 200,
  supportedExtensions: [".lua", ".luac", ".js", ".py", ".txt", ".json", ".zip", ".rar", ".7z", ".exe", ".dll"],
};

/**
 * Re-reads BOT_TOKEN/SCAN_CHANNEL_ID fresh on every call instead of caching
 * them once at process start. `process.env` (real Replit Secrets, or values
 * exported before the process launched) is checked first; the local `.env`
 * file is re-parsed as a fallback so a value written by the setup page
 * *after* this process already started is picked up without requiring a
 * restart -- `dotenv/config` only loads `.env` once, at import time, so
 * relying on `process.env` alone would miss any write that happens later.
 * @returns {{ botToken: string, scanChannelId: string, isConfigured: boolean, missingSecrets: string[] }}
 */
export function getSecretsConfig() {
  let fileValues = {};
  if (fs.existsSync(ENV_PATH)) {
    try {
      fileValues = parseEnv(fs.readFileSync(ENV_PATH, "utf8"));
    } catch {
      // Malformed .env -- fall back to whatever process.env already has.
    }
  }

  const botToken = process.env.BOT_TOKEN || fileValues.BOT_TOKEN || "";
  // SCAN_CHANNEL_ID is still preferably set as a secret (portable, not in
  // source control), but falls back to the documented default in
  // config/ids.js so the bot works out of the box on this server without
  // requiring the secret to be (re-)configured.
  const scanChannelId = process.env.SCAN_CHANNEL_ID || fileValues.SCAN_CHANNEL_ID || IDS.KEYLOGGER_SCAN_CHANNEL_ID || "";

  const missingSecrets = [];
  if (!botToken) missingSecrets.push("BOT_TOKEN");
  if (!scanChannelId) missingSecrets.push("SCAN_CHANNEL_ID");

  return { botToken, scanChannelId, isConfigured: missingSecrets.length === 0, missingSecrets };
}
