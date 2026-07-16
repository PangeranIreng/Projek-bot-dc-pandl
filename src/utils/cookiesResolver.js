/**
 * cookiesResolver.js — YouTube cookies support for yt-dlp anti-bot bypass.
 *
 * Checks (in order):
 *   1. YOUTUBE_COOKIES env var — path to an existing cookies.txt file on disk
 *   2. cookies.txt  in the project root — auto-detected, no config needed
 *
 * If no cookies file is found, COOKIES_ARGS is [] and yt-dlp runs without
 * cookies. This is the normal case — cookies are optional anti-bot assistance,
 * NOT a hard requirement. The bot continues through its full fallback chain
 * whether cookies are present or not.
 *
 * To enable cookies on Railway / Pterodactyl:
 *   1. Export your YouTube cookies from a browser (EditThisCookie / yt-dlp
 *      --cookies-from-browser) as a Netscape-format cookies.txt file.
 *   2. Either:
 *      (a) Set YOUTUBE_COOKIES=/absolute/path/to/cookies.txt as an env var, or
 *      (b) Drop the file as  cookies.txt  in the project root directory.
 *
 * Exports:
 *   COOKIES_ARGS   string[]   ["--cookies", "/path"] or []
 *   hasCookies     boolean    true when a valid cookies file was found
 *   COOKIES_PATH   string|null  resolved path, or null
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..");

function _resolveCookiesPath() {
  // ── 1. Explicit YOUTUBE_COOKIES env var ──────────────────────────────────
  const envVal = process.env.YOUTUBE_COOKIES?.trim();
  if (envVal) {
    // Support both absolute and project-root-relative paths
    const resolved = path.isAbsolute(envVal) ? envVal : path.join(PROJECT_ROOT, envVal);
    if (fs.existsSync(resolved)) {
      logger.info(`[cookiesResolver] YouTube cookies: ${resolved} (via YOUTUBE_COOKIES env)`);
      return resolved;
    }
    logger.warn(`[cookiesResolver] YOUTUBE_COOKIES is set but file not found: ${resolved} — continuing without cookies`);
  }

  // ── 2. cookies.txt in project root ────────────────────────────────────────
  const rootCookies = path.join(PROJECT_ROOT, "cookies.txt");
  if (fs.existsSync(rootCookies)) {
    logger.info(`[cookiesResolver] YouTube cookies: ${rootCookies} (project root)`);
    return rootCookies;
  }

  // No cookies available — yt-dlp will run unauthenticated.
  // This is normal and the bot will use its full provider fallback chain.
  return null;
}

export const COOKIES_PATH = _resolveCookiesPath();
export const hasCookies   = COOKIES_PATH !== null;

/** Drop into any yt-dlp args array: `[...COOKIES_ARGS, ...otherArgs]` */
export const COOKIES_ARGS = hasCookies ? ["--cookies", COOKIES_PATH] : [];
