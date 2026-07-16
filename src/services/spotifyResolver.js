/**
 * spotifyResolver.js — Resolve a Spotify track URL to downloadable metadata.
 *
 * Flow:
 *   Spotify URL
 *     ↓
 *   Spotify oEmbed API (no auth required) → title + artist
 *     ↓
 *   Build yt-dlp ytsearch1 query string
 *     ↓
 *   Return { trackId, title, artist, thumbnail, ytdlInput }
 *
 * The caller (handler.js) passes `ytdlInput` directly to ytdl(), which feeds
 * it to yt-dlp. yt-dlp handles "ytsearch1:" natively — no separate YouTube
 * search API or credentials needed.
 *
 * Exports:
 *   isSpotifyUrl(url)         → boolean
 *   resolveSpotify(url)       → Promise<{ trackId, title, artist, thumbnail, ytdlInput }>
 */

import https  from "node:https";
import { logger } from "../utils/logger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if `url` is a Spotify track, album, or playlist link.
 * Handler only calls resolveSpotify() for track links; this matcher is broader
 * so the platform detector can reject non-track Spotify URLs gracefully.
 */
export function isSpotifyUrl(url) {
  return /^https?:\/\/open\.spotify\.com\/(track|album|playlist|episode)\//i.test(url) ||
         /^https?:\/\/spotify\.link\//i.test(url);
}

/**
 * Extract the Spotify track ID from a URL.
 * @param {string} url
 * @returns {string|null}
 */
function extractTrackId(url) {
  const m = String(url).match(/track\/([a-zA-Z0-9]+)/i);
  return m?.[1] ?? null;
}

/**
 * Simple HTTPS GET → JSON promise.
 * @param {string} url
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<object>}
 */
function fetchJson(url, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: { "User-Agent": "BoomBox-Bot/1.0 (Discord)" },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end",  () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("Invalid JSON response")); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error(`Request timed out: ${url}`)); });
    req.on("error",   reject);
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Resolve a Spotify track URL to the data needed to download and cache it.
 *
 * @param {string} spotifyUrl  Must be a Spotify track URL.
 * @returns {Promise<{
 *   trackId: string,
 *   title: string,
 *   artist: string,
 *   thumbnail: string|null,
 *   ytdlInput: string,    // "ytsearch1:<artist> - <title>" — pass to ytdl()
 * }>}
 */
export async function resolveSpotify(spotifyUrl) {
  const trackId = extractTrackId(spotifyUrl);
  if (!trackId) {
    throw new Error("Spotify: cannot extract track ID from URL — only /track/ links are supported");
  }

  logger.info(`[Spotify] Resolving track ID: ${trackId}`);

  // Spotify oEmbed — public endpoint, no auth, returns title + artist + thumbnail
  const oembedUrl =
    `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;

  let title     = null;
  let artist    = null;
  let thumbnail = null;

  try {
    const data = await fetchJson(oembedUrl, 8_000);
    // oEmbed fields: { title, author_name, thumbnail_url, ... }
    title     = (data.title      ?? "").trim() || null;
    artist    = (data.author_name ?? "").trim() || null;
    thumbnail = data.thumbnail_url ?? null;
    logger.info(`[Spotify] oEmbed OK | title="${title}" artist="${artist}"`);
  } catch (e) {
    logger.warn(`[Spotify] oEmbed failed: ${e.message} — will use track ID as query`);
    // Last-resort: use the track ID so yt-dlp can at least try a search
    title  = trackId;
    artist = "";
  }

  // Build yt-dlp ytsearch1 query — "<artist> - <title> official audio"
  // The "official audio" suffix biases towards the correct upload and avoids
  // fan covers or live performances as the top result.
  const searchParts = [
    artist,
    artist ? "-" : "",
    title,
    "official audio",
  ].filter(Boolean).join(" ");

  const ytdlInput = `ytsearch1:${searchParts}`;
  logger.info(`[Spotify] Search query: ${ytdlInput}`);

  return { trackId, title, artist, thumbnail, ytdlInput };
}
