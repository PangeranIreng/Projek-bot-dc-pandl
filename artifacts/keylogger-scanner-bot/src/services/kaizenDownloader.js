/**
 * kaizenDownloader.js — Third-API fallback using kaizenapi.my.id.
 *
 * Called only when BOTH yt-dlp (all player-client variants) AND
 * @distube/ytdl-core have already failed. Never used as primary or
 * secondary — only as the last resort before giving up entirely.
 *
 * Endpoint: GET https://api.kaizenapi.my.id/ytmp3?url=<videoUrl>
 * Returns:  JSON with a direct MP3/audio download URL.
 *
 * Public interface:
 *   kaizenDownload(url, type, quality, tmpDir) →
 *     { title, thumbnail, uploader, duration, type, quality, localFile, tmpDir }
 */

import https       from "node:https";
import http        from "node:http";
import fs          from "node:fs";
import path        from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execSync }  from "node:child_process";
import { logger }   from "../utils/logger.js";

const execFileAsync = promisify(execFile);

// Resolve ffmpeg once at module load.
let FFMPEG_PATH = "ffmpeg";
try {
  FFMPEG_PATH = execSync("which ffmpeg", { encoding: "utf8" }).trim();
} catch {
  // ffmpeg not in PATH — conversion may fail; caller will surface this
}

const KAIZEN_BASE    = "https://api.kaizenapi.my.id";
const KAIZEN_TIMEOUT = 30_000; // 30s API call timeout
const DL_TIMEOUT     = 90_000; // 90s audio download timeout

// ── HTTP utilities ────────────────────────────────────────────────────────────

/**
 * Make an HTTPS GET request and return the parsed JSON body.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function _getJson(url, timeoutMs = KAIZEN_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === "https:" ? https : http;

    const req = lib.get(
      {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept:       "application/json, */*",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`kaizenapi HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`kaizenapi returned non-JSON: ${body.slice(0, 200)}`));
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("kaizenapi request timed out"));
    });
    req.on("error", (e) => reject(new Error(`kaizenapi network error: ${e.message}`)));
    req.end();
  });
}

/**
 * Download a file from `url` to `destPath`.
 * Follows up to 5 redirects.
 */
function _downloadFile(url, destPath, timeoutMs = DL_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let hops = 0;

    const step = (currentUrl) => {
      hops++;
      if (hops > 5) { reject(new Error("Too many redirects downloading audio")); return; }

      let parsed;
      try { parsed = new URL(currentUrl); } catch { reject(new Error(`Invalid audio URL: ${currentUrl}`)); return; }

      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.get(
        {
          hostname: parsed.hostname,
          path:     parsed.pathname + parsed.search,
          method:   "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            step(new URL(res.headers.location, currentUrl).toString());
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Audio download HTTP ${res.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(destPath);
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
          file.on("error", (e) => { fs.unlink(destPath, () => {}); reject(e); });
          res.on("error", (e) => { file.destroy(); reject(e); });
        },
      );
      req.on("timeout", () => { req.destroy(); reject(new Error("Audio download timed out")); });
      req.on("error", (e) => reject(new Error(`Audio download network error: ${e.message}`)));
      req.end();
    };

    step(url);
  });
}

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Extract the audio download URL and metadata from a kaizenapi response.
 * Handles multiple response shapes common among Indonesian API providers.
 */
function _parseKaizenResponse(json) {
  // Shape 1: { status: true/false, result: "url", title, thumbnail, duration }
  // Shape 2: { status: "success", url: "url", title, thumb, duration }
  // Shape 3: { data: { url: "url", title, thumbnail, duration } }
  // Shape 4: { result: { download: "url", title, thumbnail, duration } }

  const ok =
    json.status === true ||
    json.status === "success" ||
    json.status === "ok" ||
    json.success === true;

  if (!ok && json.status !== undefined && json.success !== undefined) {
    const msg = json.message || json.error || JSON.stringify(json).slice(0, 200);
    throw new Error(`kaizenapi returned failure: ${msg}`);
  }

  // Try to extract download URL from common fields
  const data = json.data ?? json.result ?? json;
  const downloadUrl =
    data.download   ||
    data.url        ||
    data.result     ||
    data.link       ||
    data.mp3        ||
    data.audio      ||
    json.download   ||
    json.url        ||
    json.result     ||
    json.link       ||
    json.mp3        ||
    json.audio      ||
    null;

  if (!downloadUrl || typeof downloadUrl !== "string" || !downloadUrl.startsWith("http")) {
    throw new Error(`kaizenapi response missing download URL: ${JSON.stringify(json).slice(0, 300)}`);
  }

  const title     = data.title     || json.title     || null;
  const thumbnail = data.thumbnail || data.thumb     || json.thumbnail || json.thumb || null;
  const uploader  = data.uploader  || data.channel   || json.uploader  || json.channel || null;
  const rawDur    = data.duration  || json.duration  || null;
  const duration  = rawDur != null && !isNaN(Number(rawDur)) ? parseInt(rawDur, 10) : null;

  return { downloadUrl, title, thumbnail, uploader, duration };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Download audio from a YouTube URL via kaizenapi.my.id.
 * This is the 3rd-API fallback — only called when yt-dlp and ytdl-core have
 * both already failed for this URL.
 *
 * @param {string} url           Full YouTube URL
 * @param {"mp3"|"mp4"} type     Output format
 * @param {string|number} quality Bitrate in kbps (e.g. "128")
 * @param {string} tmpDir        Temp directory (already created by caller)
 * @returns {Promise<{ title, thumbnail, uploader, duration, type, quality, localFile, tmpDir }>}
 */
export async function kaizenDownload(url, type, quality, tmpDir) {
  logger.info(`[kaizenDownloader] ▶ Trying kaizenapi.my.id | url="${url}"`);

  // ── Step 1: Call kaizenapi to get metadata + download URL ─────────────────
  const apiUrl = `${KAIZEN_BASE}/ytmp3?url=${encodeURIComponent(url)}`;
  logger.debug(`[kaizenDownloader] API call: ${apiUrl}`);

  let parsed;
  try {
    const json = await _getJson(apiUrl, KAIZEN_TIMEOUT);
    logger.debug(`[kaizenDownloader] API response: ${JSON.stringify(json).slice(0, 400)}`);
    parsed = _parseKaizenResponse(json);
  } catch (apiErr) {
    logger.warn(`[kaizenDownloader] API call failed: ${apiErr.message}`);
    throw new Error(`kaizenapi API error: ${apiErr.message}`);
  }

  const { downloadUrl, title, thumbnail, uploader, duration } = parsed;
  logger.info(`[kaizenDownloader] Got download URL | title="${title}" duration=${duration}s`);

  // ── Step 2: Download the audio file ───────────────────────────────────────
  // Guess extension from URL; default to mp3
  const urlPath = new URL(downloadUrl).pathname.toLowerCase();
  const ext     = urlPath.endsWith(".m4a") ? "m4a"
                : urlPath.endsWith(".mp4") ? "mp4"
                : urlPath.endsWith(".webm") ? "webm"
                : "mp3";

  const rawFile = path.join(tmpDir, `kaizen_raw.${ext}`);
  logger.info(`[kaizenDownloader] Downloading audio from CDN...`);

  try {
    await _downloadFile(downloadUrl, rawFile, DL_TIMEOUT);
  } catch (dlErr) {
    logger.warn(`[kaizenDownloader] CDN download failed: ${dlErr.message}`);
    throw new Error(`kaizenapi CDN download failed: ${dlErr.message}`);
  }

  const rawSize = (fs.statSync(rawFile).size / 1024).toFixed(1);
  logger.info(`[kaizenDownloader] Downloaded: ${rawSize} KB (ext=${ext})`);

  // ── Step 3: Convert/transcode with ffmpeg if needed ───────────────────────
  const targetExt  = type === "mp4" ? "m4a" : "mp3";
  const finalFile  = path.join(tmpDir, `kaizen_final.${targetExt}`);

  if (ext === targetExt && type === "mp3") {
    // Already the right format — just rename
    fs.renameSync(rawFile, finalFile);
  } else {
    // Transcode with ffmpeg
    const ffmpegArgs = ["-y", "-i", rawFile, "-vn"];
    if (type === "mp3") ffmpegArgs.push("-b:a", `${quality}k`);
    ffmpegArgs.push(finalFile);

    try {
      await execFileAsync(FFMPEG_PATH, ffmpegArgs, { timeout: 90_000 });
    } catch (ffErr) {
      logger.warn(`[kaizenDownloader] ffmpeg transcode failed: ${ffErr.message}`);
      throw new Error(`kaizenapi transcode failed: ${ffErr.message}`);
    }
    try { fs.unlinkSync(rawFile); } catch {}
  }

  const finalSize = (fs.statSync(finalFile).size / 1024).toFixed(1);
  logger.info(`[kaizenDownloader] ✅ Fallback succeeded | title="${title}" (${finalSize} KB)`);

  return {
    title,
    thumbnail,
    uploader,
    duration,
    type,
    quality: String(quality),
    localFile: finalFile,
    tmpDir,
  };
}
