/**
 * kaizenDownloader.js — Fallback downloader menggunakan kaizenapi.my.id.
 *
 * Dipanggil hanya saat yt-dlp (semua method) DAN @distube/ytdl-core sudah gagal.
 * Tidak dipakai sebagai primary atau secondary — hanya last-resort sebelum menyerah.
 *
 * Endpoint primer  : GET https://kaizenapi.my.id/downloader/youtube?url=<videoUrl>
 *   (dari file referensi YouTube Downloader.js — endpoint lebih baru, respons lebih cepat)
 * Endpoint sekunder: GET https://api.kaizenapi.my.id/ytmp3?url=<videoUrl>
 *   (endpoint lama — digunakan sebagai fallback jika endpoint primer gagal)
 *
 * Public interface:
 *   kaizenDownload(url, type, quality, tmpDir, signal?) →
 *     { title, thumbnail, uploader, duration, type, quality, localFile, tmpDir }
 */

import https       from "node:https";
import http        from "node:http";
import fs          from "node:fs";
import path        from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger }   from "../utils/logger.js";
import { FFMPEG_PATH, ffmpegAvailable } from "../utils/ffmpegPath.js";

const execFileAsync = promisify(execFile);

// ── Timeout constants ─────────────────────────────────────────────────────────
// API call (mendapatkan download URL): 8s — cepat gagal jika API down,
// langsung skip ke provider berikutnya tanpa memblok user.
const KAIZEN_API_TIMEOUT = 8_000;
// File download dari CDN: 60s — file audio mungkin besar, butuh waktu lebih.
const KAIZEN_DL_TIMEOUT  = 60_000;

// ── Endpoint definitions ──────────────────────────────────────────────────────

/**
 * Endpoint primer — dari file referensi YouTube Downloader.js (Hilman).
 * GET https://kaizenapi.my.id/downloader/youtube?url=<encoded>
 * Response: { status: true, result: { title, duration, audio_mp3, video_hd, thumbnail } }
 */
function _buildPrimaryUrl(videoUrl) {
  return `https://kaizenapi.my.id/downloader/youtube?url=${encodeURIComponent(videoUrl)}`;
}

function _parsePrimaryResponse(json) {
  if (!json.status) {
    const msg = json.message || json.error || JSON.stringify(json).slice(0, 200);
    throw new Error(`kaizenapi primary endpoint failure: ${msg}`);
  }
  const r = json.result;
  if (!r) throw new Error("kaizenapi primary: response missing 'result' field");
  const downloadUrl = r.audio_mp3 || r.url || r.link || r.mp3 || r.audio || null;
  if (!downloadUrl || typeof downloadUrl !== "string" || !downloadUrl.startsWith("http")) {
    throw new Error(`kaizenapi primary: no audio download URL in result: ${JSON.stringify(r).slice(0, 200)}`);
  }
  const rawDur   = r.duration || null;
  const duration = rawDur != null && !isNaN(Number(rawDur)) ? parseInt(rawDur, 10) : null;
  return {
    downloadUrl,
    title:     r.title     || null,
    thumbnail: r.thumbnail || null,
    uploader:  r.uploader  || r.channel || null,
    duration,
  };
}

/**
 * Endpoint sekunder — endpoint lama sebagai fallback.
 * GET https://api.kaizenapi.my.id/ytmp3?url=<encoded>
 * Response: berbagai shape (ditangani oleh _parseFallbackResponse)
 */
function _buildSecondaryUrl(videoUrl) {
  return `https://api.kaizenapi.my.id/ytmp3?url=${encodeURIComponent(videoUrl)}`;
}

function _parseFallbackResponse(json) {
  // Shape 1: { status: true/false, result: "url", title, thumbnail, duration }
  // Shape 2: { status: "success", url: "url", title, thumb, duration }
  // Shape 3: { data: { url: "url", title, thumbnail, duration } }
  // Shape 4: { result: { download: "url", title, thumbnail, duration } }
  const ok =
    json.status === true   ||
    json.status === "success" ||
    json.status === "ok"   ||
    json.success === true;

  if (!ok && json.status !== undefined && json.success !== undefined) {
    const msg = json.message || json.error || JSON.stringify(json).slice(0, 200);
    throw new Error(`kaizenapi secondary returned failure: ${msg}`);
  }

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
    throw new Error(`kaizenapi secondary: missing download URL: ${JSON.stringify(json).slice(0, 300)}`);
  }

  const title     = data.title     || json.title     || null;
  const thumbnail = data.thumbnail || data.thumb     || json.thumbnail || json.thumb || null;
  const uploader  = data.uploader  || data.channel   || json.uploader  || json.channel || null;
  const rawDur    = data.duration  || json.duration  || null;
  const duration  = rawDur != null && !isNaN(Number(rawDur)) ? parseInt(rawDur, 10) : null;

  return { downloadUrl, title, thumbnail, uploader, duration };
}

// ── HTTP utilities ────────────────────────────────────────────────────────────

/**
 * Make an HTTPS/HTTP GET request and return the parsed JSON body.
 * Respects AbortSignal — jika signal di-abort sebelum respons datang, langsung reject.
 */
function _getJson(url, timeoutMs = KAIZEN_API_TIMEOUT, signal = undefined) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Dibatalkan (abort signal)"));
      return;
    }

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
            reject(new Error(`kaizenapi non-JSON response: ${body.slice(0, 200)}`));
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`kaizenapi request timed out (>${timeoutMs / 1000}s)`));
    });
    req.on("error", (e) => reject(new Error(`kaizenapi network error: ${e.message}`)));

    // AbortSignal integration — kill request immediately if stage times out.
    const onAbort = () => {
      req.destroy();
      const e = new Error("Dibatalkan (timeout tahap)");
      e.name = "AbortError";
      reject(e);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));

    req.end();
  });
}

/**
 * Download a file from `url` to `destPath`.
 * Follows up to 5 redirects. Respects AbortSignal.
 */
function _downloadFile(url, destPath, timeoutMs = KAIZEN_DL_TIMEOUT, signal = undefined) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Dibatalkan (abort signal)"), { name: "AbortError" }));
      return;
    }

    let hops = 0;
    let settled = false;

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    const onAbort = () => {
      settle(reject, Object.assign(new Error("Dibatalkan (timeout tahap)"), { name: "AbortError" }));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const step = (currentUrl) => {
      hops++;
      if (hops > 5) { settle(reject, new Error("Too many redirects downloading audio")); return; }

      let parsed;
      try { parsed = new URL(currentUrl); } catch { settle(reject, new Error(`Invalid audio URL: ${currentUrl}`)); return; }

      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.get(
        {
          hostname: parsed.hostname,
          path:     parsed.pathname + parsed.search,
          method:   "GET",
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
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
            settle(reject, new Error(`Audio download HTTP ${res.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(destPath);
          res.pipe(file);
          file.on("finish", () => file.close(() => settle(resolve, undefined)));
          file.on("error", (e) => { try { fs.unlinkSync(destPath); } catch {} settle(reject, e); });
          res.on("error", (e) => { file.destroy(); settle(reject, e); });
        },
      );
      req.on("timeout", () => { req.destroy(); settle(reject, new Error(`Audio download timed out (>${timeoutMs / 1000}s)`)); });
      req.on("error", (e) => settle(reject, new Error(`Audio download network error: ${e.message}`)));
    };

    step(url);
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Download audio dari YouTube via kaizenapi.my.id.
 * Mencoba endpoint primer (kaizenapi.my.id/downloader/youtube) dulu;
 * jika gagal, fallback ke endpoint sekunder (api.kaizenapi.my.id/ytmp3).
 *
 * @param {string}             url      Full YouTube URL
 * @param {"mp3"|"mp4"}        type     Output format
 * @param {string|number}      quality  Bitrate kbps (e.g. "128")
 * @param {string}             tmpDir   Temp directory (sudah dibuat oleh caller)
 * @param {AbortSignal}        [signal] AbortSignal dari stage timeout handler
 * @returns {Promise<{ title, thumbnail, uploader, duration, type, quality, localFile, tmpDir }>}
 */
export async function kaizenDownload(url, type, quality, tmpDir, signal = undefined) {
  logger.info(`[kaizenDownloader] ▶ Trying kaizenapi.my.id | url="${url}"`);

  // ── Step 1: Call API untuk mendapatkan metadata + download URL ────────────
  // Coba endpoint primer (dari file referensi), fallback ke endpoint sekunder.
  let parsed;
  const endpoints = [
    { name: "primer (kaizenapi.my.id/downloader/youtube)", buildUrl: _buildPrimaryUrl, parseRes: _parsePrimaryResponse },
    { name: "sekunder (api.kaizenapi.my.id/ytmp3)",        buildUrl: _buildSecondaryUrl, parseRes: _parseFallbackResponse },
  ];

  let lastApiErr = null;
  for (const ep of endpoints) {
    if (signal?.aborted) {
      const e = new Error("Dibatalkan (timeout tahap)"); e.name = "AbortError"; throw e;
    }
    const apiUrl = ep.buildUrl(url);
    logger.debug(`[kaizenDownloader] API call [${ep.name}]: ${apiUrl}`);
    try {
      const json = await _getJson(apiUrl, KAIZEN_API_TIMEOUT, signal);
      logger.debug(`[kaizenDownloader] API response [${ep.name}]: ${JSON.stringify(json).slice(0, 300)}`);
      parsed = ep.parseRes(json);
      logger.info(`[kaizenDownloader] ✓ Endpoint ${ep.name} berhasil`);
      break;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      logger.warn(`[kaizenDownloader] Endpoint ${ep.name} gagal: ${err.message} → mencoba berikutnya`);
      lastApiErr = err;
    }
  }

  if (!parsed) {
    throw new Error(`kaizenapi semua endpoint gagal: ${lastApiErr?.message ?? "unknown"}`);
  }

  const { downloadUrl, title, thumbnail, uploader, duration } = parsed;
  logger.info(`[kaizenDownloader] Got download URL | title="${title}" duration=${duration}s`);

  // ── Step 2: Download file audio ───────────────────────────────────────────
  const urlPath = (() => {
    try { return new URL(downloadUrl).pathname.toLowerCase(); } catch { return ""; }
  })();
  const ext = urlPath.endsWith(".m4a")  ? "m4a"
             : urlPath.endsWith(".mp4")  ? "mp4"
             : urlPath.endsWith(".webm") ? "webm"
             : "mp3";

  const rawFile = path.join(tmpDir, `kaizen_raw.${ext}`);
  logger.info(`[kaizenDownloader] Downloading audio from CDN...`);

  try {
    await _downloadFile(downloadUrl, rawFile, KAIZEN_DL_TIMEOUT, signal);
  } catch (dlErr) {
    if (dlErr.name === "AbortError") throw dlErr;
    logger.warn(`[kaizenDownloader] CDN download gagal: ${dlErr.message}`);
    throw new Error(`kaizenapi CDN download failed: ${dlErr.message}`);
  }

  if (signal?.aborted) {
    try { fs.unlinkSync(rawFile); } catch {}
    const e = new Error("Dibatalkan (timeout tahap)"); e.name = "AbortError"; throw e;
  }

  const rawSize = (fs.statSync(rawFile).size / 1024).toFixed(1);
  logger.info(`[kaizenDownloader] Downloaded: ${rawSize} KB (ext=${ext})`);

  // ── Step 3: Transcode dengan ffmpeg jika perlu ────────────────────────────
  const targetExt = type === "mp4" ? "m4a" : "mp3";
  const finalFile = path.join(tmpDir, `kaizen_final.${targetExt}`);

  // Skip ffmpeg entirely when the CDN already returned the target format.
  // Kaizen often delivers mp3 directly — no re-encode needed, just rename.
  if (ext === targetExt) {
    fs.renameSync(rawFile, finalFile);
    logger.info(`[kaizenDownloader] Skipping ffmpeg — already ${targetExt}`);
  } else {
    // Transcode using ffmpeg (always available via ffmpeg-static bundle).
    logger.info(`[kaizenDownloader] Transcoding ${ext} → ${targetExt} with ffmpeg`);
    const ffmpegArgs = ["-y", "-i", rawFile, "-vn"];
    if (type === "mp3") ffmpegArgs.push("-b:a", `${quality}k`);
    ffmpegArgs.push(finalFile);

    try {
      await execFileAsync(FFMPEG_PATH, ffmpegArgs, { timeout: 60_000 });
    } catch (ffErr) {
      logger.warn(`[kaizenDownloader] ffmpeg transcode gagal: ${ffErr.message}`);
      // Last resort: if ffmpeg failed but we have a valid raw file, serve it
      // as-is so the user still gets audio (format may differ from request).
      if (fs.existsSync(rawFile)) {
        logger.warn(`[kaizenDownloader] Serving raw file as fallback (ext=${ext})`);
        fs.renameSync(rawFile, path.join(path.dirname(finalFile), `kaizen_final.${ext}`));
        const rawFallback = path.join(path.dirname(finalFile), `kaizen_final.${ext}`);
        const rawSize = (fs.statSync(rawFallback).size / 1024).toFixed(1);
        logger.info(`[kaizenDownloader] ✅ Kaizen berhasil (raw fallback, ${rawSize} KB)`);
        return { title, thumbnail, uploader, duration, type, quality: String(quality), localFile: rawFallback, tmpDir };
      }
      throw new Error(`kaizenapi transcode failed: ${ffErr.message}`);
    }
    try { fs.unlinkSync(rawFile); } catch {}
  }

  const finalSize = (fs.statSync(finalFile).size / 1024).toFixed(1);
  logger.info(`[kaizenDownloader] ✅ Kaizen berhasil | title="${title}" (${finalSize} KB)`);

  return { title, thumbnail, uploader, duration, type, quality: String(quality), localFile: finalFile, tmpDir };
}
