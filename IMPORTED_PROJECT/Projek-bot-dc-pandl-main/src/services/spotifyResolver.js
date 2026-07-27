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
import {
  shouldSkip,
  recordSuccess,
  recordFailure,
} from "./providerHealth.js";

const PROVIDER_KEY = "spotify-oembed";

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

  // ── Circuit breaker for Spotify oEmbed ────────────────────────────────────
  // If the oEmbed endpoint has failed repeatedly, skip it and fall back to the
  // track-ID query immediately rather than burning 2× 8s timeouts per request.
  const oembedSkipped = shouldSkip(PROVIDER_KEY);
  if (oembedSkipped) {
    logger.warn(`[Spotify] oEmbed circuit breaker OPEN — skipping fetch, using track ID fallback`);
    title  = trackId;
    artist = "";
  }

  // Retry oEmbed up to 2 times — a single network hiccup shouldn't lose
  // the title/artist that is needed to build a good search query.
  let oembedErr;
  if (!oembedSkipped) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await fetchJson(oembedUrl, 8_000);
        // oEmbed fields: { title, author_name, thumbnail_url, ... }
        title     = (data.title       ?? "").trim() || null;
        artist    = (data.author_name ?? "").trim() || null;
        thumbnail = data.thumbnail_url ?? null;
        logger.info(`[Spotify] oEmbed OK (attempt ${attempt}) | title="${title}" artist="${artist}"`);
        recordSuccess(PROVIDER_KEY);
        oembedErr = null;
        break;
      } catch (e) {
        oembedErr = e;
        recordFailure(PROVIDER_KEY, { reason: e.message });
        if (attempt < 2) {
          logger.warn(`[Spotify] oEmbed attempt ${attempt} failed: ${e.message} — retrying in 1s`);
          await new Promise(r => setTimeout(r, 1_000));
        }
      }
    }
    if (oembedErr) {
      logger.warn(`[Spotify] oEmbed failed after 2 attempts: ${oembedErr.message} — will use track ID as query`);
      // Last-resort: use the track ID so yt-dlp can at least try a search
      title  = trackId;
      artist = "";
    }
  }

  // Build a prioritized list of yt-dlp ytsearch queries.
  // Ordered from most specific to broadest — the handler tries each in sequence.
  // Using ytsearch3: (top-3 results) instead of ytsearch1: for the main queries
  // increases the chance that the correct video is in the result set,
  // while keeping the search fast (yt-dlp returns the best match for text queries).
  const searchCandidates = [];

  if (artist && title) {
    // Bersihkan artist dari karakter ekstra (feat., ft., &, dll)
    const cleanArtist = artist.replace(/\s*(feat\.|ft\.|&|,)[^-]*/gi, "").trim();
    // Bersihkan title dari (feat. ...) dan (Official ...)
    const cleanTitle  = title.replace(/\s*\([^)]*(?:feat\.|ft\.|official|video|audio|lyric|lyrics)[^)]*\)/gi, "").trim();

    // Primary: "Artist - Title official audio" — paling spesifik, biasanya tepat
    searchCandidates.push(`ytsearch1:${artist} - ${title} official audio`);
    // Fallback 1: versi bersih tanpa "(feat.)" noise
    if (cleanTitle !== title || cleanArtist !== artist) {
      searchCandidates.push(`ytsearch1:${cleanArtist} - ${cleanTitle} official audio`);
    }
    // Fallback 2: tanpa suffix "official audio" — untuk yang tidak ada label
    searchCandidates.push(`ytsearch1:${artist} - ${title}`);
    // Fallback 3: judul + artist (urutan terbalik) — untuk re-upload / cover
    searchCandidates.push(`ytsearch1:${title} ${artist}`);
    // Fallback 4: judul bersih saja — broad search jika artist name bermasalah
    searchCandidates.push(`ytsearch1:${cleanTitle} ${cleanArtist}`);
  } else if (title) {
    searchCandidates.push(`ytsearch1:${title} official audio`);
    searchCandidates.push(`ytsearch1:${title}`);
  } else {
    searchCandidates.push(`ytsearch1:${trackId}`);
  }

  // Deduplicate — jika query yang sama muncul lebih dari sekali, hapus duplikat
  const seen = new Set();
  const uniqueCandidates = searchCandidates.filter(q => {
    if (seen.has(q)) return false;
    seen.add(q);
    return true;
  });

  const ytdlInput = uniqueCandidates[0];
  logger.info(`[Spotify] Primary search query: ${ytdlInput} (${uniqueCandidates.length} candidates total)`);

  return { trackId, title, artist, thumbnail, ytdlInput, searchCandidates: uniqueCandidates };
}
