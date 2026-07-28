/**
 * kyzzDownloader.js — BoomBox audio/video provider using Kyzz API.
 *
 * Used as an additional fallback in the BoomBox provider chain after
 * yt-dlp, ytdl-core, and kaizenDownloader fail.
 *
 * Endpoints used:
 *   /api/download/aio     — Universal (YouTube, TikTok, Instagram, FB, Twitter, etc.)
 *   /api/download/ytmp3   — YouTube audio fallback
 *   /api/download/ytmp4   — YouTube video fallback
 *
 * Public interface:
 *   kyzzYtAudio(url, quality, tmpDir, signal?)
 *     → { title, thumbnail, uploader, duration, type, quality, localFile, tmpDir, provider }
 *   kyzzAioDownload(url, tmpDir, signal?)
 *     → { title, thumbnail, uploader, duration, type, quality, localFile, tmpDir, provider }
 */

import fs   from "node:fs";
import path from "node:path";
import https from "node:https";
import http  from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger }   from "../utils/logger.js";
import { kyzzGet }  from "./kyzzClient.js";
import { FFMPEG_PATH } from "../utils/ffmpegPath.js";
import {
  shouldSkip,
  recordSuccess,
  recordFailure,
} from "./providerHealth.js";

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────────────────────────────────────

const PROVIDER_YTMP3 = "kyzz-ytmp3";
const PROVIDER_YTMP4 = "kyzz-ytmp4";
const PROVIDER_AIO   = "kyzz-aio";
const DL_TIMEOUT_MS  = 90_000;  // file download timeout

// ── File download helper ──────────────────────────────────────────────────────

function _downloadFile(url, destPath, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(Object.assign(new Error("Dibatalkan"), { name: "AbortError" }));
    }

    let hops    = 0;
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };

    const onAbort = () => settle(reject, Object.assign(new Error("Dibatalkan (timeout tahap)"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });

    const step = (currentUrl) => {
      hops++;
      if (hops > 8) return settle(reject, new Error("Too many redirects"));

      let parsed;
      try { parsed = new URL(currentUrl); }
      catch { return settle(reject, new Error(`Invalid URL: ${currentUrl}`)); }

      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.get(
        {
          hostname: parsed.hostname,
          path:     parsed.pathname + parsed.search,
          headers:  { "User-Agent": "Mozilla/5.0 (compatible; BoomBot/3.0)" },
          timeout:  DL_TIMEOUT_MS,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            try { step(new URL(res.headers.location, currentUrl).toString()); }
            catch { settle(reject, new Error("Bad redirect")); }
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            return settle(reject, new Error(`File download HTTP ${res.statusCode}`));
          }
          const file = fs.createWriteStream(destPath);
          res.pipe(file);
          file.on("finish", () => file.close(() => settle(resolve, undefined)));
          file.on("error",  (e) => { try { fs.unlinkSync(destPath); } catch {} settle(reject, e); });
          res.on("error",   (e) => { file.destroy(); settle(reject, e); });
        },
      );
      req.on("timeout", () => { req.destroy(); settle(reject, new Error("File download timed out")); });
      req.on("error",   (e) => settle(reject, new Error(`Download network error: ${e.message}`)));
    };

    step(url);
  });
}

// ── ffmpeg transcode helper ───────────────────────────────────────────────────

async function _transcodeToMp3(rawFile, destFile, quality) {
  const args = ["-y", "-i", rawFile, "-vn", "-b:a", `${quality}k`, destFile];
  await execFileAsync(FFMPEG_PATH, args, { timeout: 90_000 });
}

// ── Response parsers ──────────────────────────────────────────────────────────

function _extractDownloadUrl(json) {
  // Many possible shapes from Kyzz API:
  // { status: true, result: { download_url, url, audio, mp3, link, ... } }
  // { success: true, data: { url, ... } }
  // { status: "ok", url: "...", ... }

  const ok =
    json.status === true || json.status === "ok" || json.status === "success" ||
    json.success === true || json.code === 200;

  const r = json.result ?? json.data ?? json;

  const downloadUrl =
    r.download_url || r.download || r.audio_url || r.audio ||
    r.mp3 || r.url || r.link || r.stream_url ||
    json.download_url || json.download || json.audio || json.mp3 ||
    json.url || json.link || null;

  if (!downloadUrl || typeof downloadUrl !== "string" || !downloadUrl.startsWith("http")) {
    const msg = json.message || json.error || `No download URL found in response: ${JSON.stringify(json).slice(0, 200)}`;
    throw new Error(`Kyzz API: ${msg}`);
  }

  const rawDur   = r.duration || json.duration || null;
  const duration = rawDur != null && !isNaN(Number(rawDur)) ? Math.round(Number(rawDur)) : null;

  return {
    downloadUrl,
    title:     r.title     || json.title     || null,
    thumbnail: r.thumbnail || json.thumbnail || r.thumb || json.thumb || null,
    uploader:  r.uploader  || json.uploader  || r.channel || json.channel || r.author || json.author || null,
    duration,
  };
}

function _extractAioUrl(json) {
  // AIO may return an array of media items or a single item
  const ok =
    json.status === true || json.status === "ok" || json.status === "success" ||
    json.success === true;

  let mediaItems = null;

  if (Array.isArray(json.result)) mediaItems = json.result;
  else if (Array.isArray(json.data))   mediaItems = json.data;
  else if (Array.isArray(json.medias)) mediaItems = json.medias;

  if (mediaItems && mediaItems.length > 0) {
    // Prefer audio/mp3 items, then video
    const audio = mediaItems.find(m =>
      m.type === "audio" || m.ext === "mp3" || m.quality === "audio" ||
      /mp3|audio/i.test(m.quality || "") || /mp3|audio/i.test(m.type || "")
    ) || mediaItems[0];

    const url = audio.url || audio.download_url || audio.src || audio.link;
    if (url && url.startsWith("http")) {
      const rawDur = json.duration || audio.duration || null;
      return {
        downloadUrl: url,
        title:     json.title || audio.title || null,
        thumbnail: json.thumbnail || audio.thumbnail || null,
        uploader:  json.uploader || audio.uploader || json.author || null,
        duration:  rawDur != null && !isNaN(Number(rawDur)) ? Math.round(Number(rawDur)) : null,
      };
    }
  }

  // Fallback to flat structure
  return _extractDownloadUrl(json);
}

// ── Core download + transcode pipeline ────────────────────────────────────────

async function _downloadAndTranscode(downloadUrl, tmpDir, quality, providerKey, signal) {
  const ext = (() => {
    try {
      const p = new URL(downloadUrl).pathname.toLowerCase();
      if (p.endsWith(".m4a"))  return "m4a";
      if (p.endsWith(".mp4"))  return "mp4";
      if (p.endsWith(".webm")) return "webm";
      if (p.endsWith(".ogg"))  return "ogg";
      return "mp3";
    } catch { return "mp3"; }
  })();

  const rawFile   = path.join(tmpDir, `kyzz_raw.${ext}`);
  const finalFile = path.join(tmpDir, "kyzz_final.mp3");

  logger.info(`[kyzzDownloader:${providerKey}] Downloading audio (ext=${ext})...`);
  await _downloadFile(downloadUrl, rawFile, signal);

  const rawSize = (fs.statSync(rawFile).size / 1024).toFixed(1);
  logger.info(`[kyzzDownloader:${providerKey}] Downloaded: ${rawSize} KB`);

  // Skip transcode if already mp3
  if (ext === "mp3") {
    fs.renameSync(rawFile, finalFile);
    logger.info(`[kyzzDownloader:${providerKey}] Skipping transcode — already mp3`);
    return finalFile;
  }

  // Transcode to mp3
  try {
    await _transcodeToMp3(rawFile, finalFile, quality);
    try { fs.unlinkSync(rawFile); } catch {}
  } catch (ffErr) {
    logger.warn(`[kyzzDownloader:${providerKey}] ffmpeg failed: ${ffErr.message} — serving raw`);
    // Serve raw file as fallback
    const rawFallback = path.join(tmpDir, `kyzz_final.${ext}`);
    fs.renameSync(rawFile, rawFallback);
    return rawFallback;
  }

  const finalSize = (fs.statSync(finalFile).size / 1024).toFixed(1);
  logger.info(`[kyzzDownloader:${providerKey}] Final: ${finalSize} KB`);
  return finalFile;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Download YouTube audio via Kyzz /api/download/ytmp3.
 * Used as a BoomBox fallback specifically for YouTube audio.
 *
 * @param {string}   url      YouTube URL
 * @param {number}   quality  Bitrate (kbps, e.g. 128)
 * @param {string}   tmpDir   Temp directory (already created)
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} BoomBox-compatible result object
 */
export async function kyzzYtAudio(url, quality = 128, tmpDir, signal) {
  if (shouldSkip(PROVIDER_YTMP3)) {
    throw Object.assign(new Error("kyzz-ytmp3 skipped (circuit breaker)"), { code: "CIRCUIT_OPEN" });
  }

  logger.info(`[kyzzDownloader] ▶ ytmp3 | ${url}`);

  let meta;
  // Try ytmp3 first, fallback to aio
  for (const ep of ["/api/download/ytmp3", "/api/download/aio"]) {
    try {
      const json = await kyzzGet(ep, { url }, { timeoutMs: 15_000, signal });
      meta = ep === "/api/download/aio" ? _extractAioUrl(json) : _extractDownloadUrl(json);
      logger.info(`[kyzzDownloader] ytmp3 via ${ep}: title="${meta.title}"`);
      break;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      logger.warn(`[kyzzDownloader] ytmp3 endpoint ${ep} failed: ${err.message}`);
      if (ep === "/api/download/aio") throw err;
    }
  }

  const localFile = await _downloadAndTranscode(meta.downloadUrl, tmpDir, quality, PROVIDER_YTMP3, signal);
  recordSuccess(PROVIDER_YTMP3);

  return {
    title:    meta.title,
    thumbnail: meta.thumbnail,
    uploader: meta.uploader,
    duration: meta.duration,
    type:     "mp3",
    quality:  String(quality),
    localFile,
    tmpDir,
    provider: "kyzz-ytmp3",
  };
}

/**
 * Download any platform's audio/video via Kyzz /api/download/aio.
 * Supports YouTube, TikTok, Instagram, Facebook, Twitter/X, SoundCloud, etc.
 *
 * @param {string}   url      Source URL (any supported platform)
 * @param {string}   tmpDir   Temp directory (already created)
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} BoomBox-compatible result object
 */
export async function kyzzAioDownload(url, tmpDir, signal) {
  if (shouldSkip(PROVIDER_AIO)) {
    throw Object.assign(new Error("kyzz-aio skipped (circuit breaker)"), { code: "CIRCUIT_OPEN" });
  }

  logger.info(`[kyzzDownloader] ▶ aio | ${url}`);

  const json = await kyzzGet("/api/download/aio", { url }, { timeoutMs: 20_000, signal });
  const meta = _extractAioUrl(json);

  const localFile = await _downloadAndTranscode(meta.downloadUrl, tmpDir, 128, PROVIDER_AIO, signal);
  recordSuccess(PROVIDER_AIO);

  return {
    title:    meta.title,
    thumbnail: meta.thumbnail,
    uploader: meta.uploader,
    duration: meta.duration,
    type:     "mp3",
    quality:  "128",
    localFile,
    tmpDir,
    provider: "kyzz-aio",
  };
}

/**
 * Download Instagram media via Kyzz /api/download/instagram.
 * Prioritized over AIO for Instagram URLs.
 *
 * @param {string}   url
 * @param {string}   tmpDir
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
export async function kyzzInstagramDownload(url, tmpDir, signal) {
  logger.info(`[kyzzDownloader] ▶ instagram | ${url}`);

  let meta;
  for (const ep of ["/api/download/instagram", "/api/download/aio"]) {
    try {
      const json = await kyzzGet(ep, { url }, { timeoutMs: 20_000, signal });
      meta = _extractAioUrl(json);
      break;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      logger.warn(`[kyzzDownloader] Instagram endpoint ${ep} failed: ${err.message}`);
      if (ep === "/api/download/aio") throw err;
    }
  }

  const localFile = await _downloadAndTranscode(meta.downloadUrl, tmpDir, 128, "kyzz-instagram", signal);

  return {
    title:    meta.title,
    thumbnail: meta.thumbnail,
    uploader: meta.uploader,
    duration: meta.duration,
    type:     "mp3",
    quality:  "128",
    localFile,
    tmpDir,
    provider: "kyzz-instagram",
  };
}
