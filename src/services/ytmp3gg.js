/**
 * ytmp3gg.js — Audio downloader using yt-dlp_linux.
 *
 * Supports YouTube and TikTok. TikTok uses a 5-method automatic fallback —
 * each method varies headers, cert checking, format selection, and retry
 * settings. Only throws after ALL methods are exhausted.
 *
 * Public interface:
 *   ytdl(url, type, quality)  → { title, thumbnail, uploader, duration,
 *                                  type, quality, localFile, tmpDir }
 *   getVideoInfo(url)         → { title, thumbnail, uploader, duration }
 *                                (simulate only — no download, fast)
 */

import { execFile }      from "node:child_process";
import { promisify }     from "node:util";
import { execSync }      from "node:child_process";
import fs                from "node:fs";
import path              from "node:path";
import os                from "node:os";
import https             from "node:https";
import { fileURLToPath } from "node:url";
import ytdlCore           from "@distube/ytdl-core";
import { kaizenDownload } from "./kaizenDownloader.js";
import { logger }        from "../utils/logger.js";
import * as providerHealth from "./providerHealth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// FIX (root cause): ytmp3gg.js is at src/services/ — two levels up reaches
// the workspace root, so BIN_DIR resolves to <root>/bin/ where yt-dlp_linux
// is committed. Previously only one ".." was used → src/bin/ (non-existent),
// causing every request to attempt a fresh binary download from GitHub and
// fail with a 30s timeout before any fallback provider was tried.
const BIN_DIR   = path.join(__dirname, "..", "..", "bin");
const BIN_PATH  = path.join(BIN_DIR, "yt-dlp_linux");
const YTDLP_DL  = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

const execFileAsync = promisify(execFile);

// Resolve ffmpeg once at startup.
let FFMPEG_PATH = "ffmpeg";
try {
  FFMPEG_PATH = execSync("which ffmpeg", { encoding: "utf8" }).trim();
  logger.info(`[ytmp3gg] ffmpeg found at: ${FFMPEG_PATH}`);
} catch {
  logger.warn("[ytmp3gg] ffmpeg not found in PATH — audio conversion may fail");
}

// Shared keep-alive agent — reused across every outbound HTTPS request this
// module makes (TikTok redirect resolution) so repeated calls don't pay a
// fresh TCP+TLS handshake every time.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

// ── Generic timeout helper ────────────────────────────────────────────────────
//
// Races an arbitrary promise against a hard ceiling. Used to bound any
// request/stream that has no built-in timeout of its own (e.g. ytdl-core,
// which does not expose a timeout option) so it can never hang a queue slot
// forever. Does not cancel the underlying work -- callers that can abort
// (streams, requests) should still do so themselves; this just guarantees
// the *caller* is unblocked.
function _withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.code = "YTMP3GG_TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Binary bootstrap ──────────────────────────────────────────────────────────
//
// FIX: ensureBinary() used to run a GitHub API version-check on EVERY request.
// Under 20 concurrent users this fired 20+ network calls simultaneously,
// blocking the "Analyzing Link..." stage for every job and racing to download
// the same binary file concurrently (no mutex). Now:
//   • initBinary()   — exported, called ONCE at startup (ready.js). Downloads
//                      the binary if missing and does the GitHub version check.
//                      Subsequent calls return the same singleton promise.
//   • ensureBinary() — per-request fast path: just verifies the file exists
//                      (fs.existsSync, no network). Falls back to initBinary()
//                      only if the binary is somehow missing at request time.
//
// This eliminates all per-request GitHub calls AND the concurrent-download race.

const BINARY_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Singleton promise for the one-time startup init. */
let _binaryInitPromise = null;

/**
 * Called ONCE at startup (from ready.js / handleReady).
 * Downloads the binary if missing, then checks GitHub for a newer release.
 * Safe to call multiple times — only runs once; extra calls return the same
 * already-settled promise.
 *
 * @returns {Promise<void>}
 */
export function initBinary() {
  if (!_binaryInitPromise) {
    _binaryInitPromise = _doInitBinary()
      .catch((err) => {
        // Don't permanently block future requests if startup init fails.
        // Clear the singleton so the first real request retries download.
        _binaryInitPromise = null;
        logger.error(`[ytmp3gg] Binary pre-init failed: ${err.message}`);
        // Non-fatal at startup — bot continues; ensureBinary() retries on first request.
      });
  }
  return _binaryInitPromise;
}

/** The actual one-time init work. @private */
async function _doInitBinary() {
  if (!fs.existsSync(BIN_PATH)) {
    await _downloadBinary();
    return;
  }
  let localVersion = null;
  try {
    const { stdout } = await execFileAsync(BIN_PATH, ["--version"], { timeout: 10_000 });
    localVersion = stdout.trim();
  } catch {
    logger.warn("[ytmp3gg] Could not read yt-dlp version — re-downloading");
    await _downloadBinary();
    return;
  }
  try {
    const latestVersion = await _fetchLatestYtdlpVersion();
    if (latestVersion && latestVersion !== localVersion) {
      logger.info(`[ytmp3gg] Updating yt-dlp: ${localVersion} → ${latestVersion}`);
      await _downloadBinary();
      logger.info(`[ytmp3gg] yt-dlp updated to ${latestVersion}`);
    } else {
      logger.info(`[ytmp3gg] yt-dlp up to date (${localVersion})`);
    }
  } catch (err) {
    logger.warn(`[ytmp3gg] yt-dlp version check failed — using ${localVersion}: ${err.message}`);
  }
}

/**
 * Per-request binary check. Fast path: binary already exists → returns
 * immediately (no network). Fallback: if missing, triggers a re-download
 * (guards against concurrent re-downloads via the singleton pattern).
 *
 * FIX: if the binary is genuinely unavailable AND yt-dlp providers are already
 * OFFLINE, skip the download attempt entirely and throw YTDLP_BINARY_UNAVAILABLE
 * so callers (getVideoInfo, ytdl) can skip yt-dlp and use backup providers
 * without burning another 30s waiting for a GitHub download that will fail.
 * @private
 */
async function ensureBinary() {
  // If both yt-dlp providers are already OFFLINE (e.g. from a failed binary
  // download attempt), skip straight to throwing so callers bypass yt-dlp.
  if (providerHealth.shouldSkip("yt-dlp-youtube") && providerHealth.shouldSkip("yt-dlp-tiktok")) {
    const err = new Error("yt-dlp binary unavailable — providers marked OFFLINE, using backup chain");
    err.code = "YTDLP_BINARY_UNAVAILABLE";
    throw err;
  }

  // Wait for startup init if it's still in progress. If it already completed
  // (or was never started), this is a no-op.
  if (_binaryInitPromise) {
    await _binaryInitPromise.catch(() => {}); // init failure is non-fatal here
  }
  // Fast path — binary is present, no network needed.
  if (fs.existsSync(BIN_PATH)) return;

  // Binary is missing (init failed, or first request arrived before init ran).
  // Re-use the singleton so concurrent requests don't double-download.
  logger.warn("[ytmp3gg] yt-dlp binary missing at request time — downloading now");
  if (!_binaryInitPromise) {
    _binaryInitPromise = _downloadBinary()
      .then(() => { logger.info("[ytmp3gg] yt-dlp re-downloaded on demand"); })
      .catch((downloadErr) => {
        // FIX: binary download failed — drive both yt-dlp providers to OFFLINE
        // (5x = threshold) so the NEXT call to ensureBinary() returns
        // YTDLP_BINARY_UNAVAILABLE immediately instead of retrying the 30s
        // download.  Backup providers (ytdl-core, kaizenapi) do not need the
        // binary and will be used automatically via the fallback chain.
        logger.error(`[ytmp3gg] Binary download failed — marking yt-dlp OFFLINE: ${downloadErr.message}`);
        for (let i = 0; i < 5; i++) {
          providerHealth.recordFailure("yt-dlp-youtube", { reason: `Binary unavailable: ${downloadErr.message}`, isTimeout: true });
          providerHealth.recordFailure("yt-dlp-tiktok",  { reason: `Binary unavailable: ${downloadErr.message}`, isTimeout: true });
        }
        throw downloadErr; // re-throw so callers know yt-dlp is unavailable
      })
      .finally(() => { _binaryInitPromise = null; }); // allow future re-check after cooldown
  }
  await _binaryInitPromise;
}

/** Download (or re-download) the yt-dlp_linux binary from GitHub. */
async function _downloadBinary() {
  logger.info("[ytmp3gg] Downloading yt-dlp_linux from GitHub...");
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // Write to a temp path first; rename on success so a partial download
  // never leaves a corrupt binary in place.
  const tmpPath = BIN_PATH + ".tmp";
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmpPath);

    function fetch(url) {
      const req = https.get(url, { timeout: BINARY_DOWNLOAD_TIMEOUT_MS }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.destroy();
          fetch(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub returned HTTP ${res.statusCode} for yt-dlp binary`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        res.on("error", (e) => { file.destroy(); reject(e); });
      });
      req.on("timeout", () => {
        req.destroy(new Error(`yt-dlp binary download timed out (>${BINARY_DOWNLOAD_TIMEOUT_MS / 1000}s idle)`));
      });
      req.on("error", (e) => {
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(e);
      });
    }

    fetch(YTDLP_DL);
  });

  fs.renameSync(tmpPath, BIN_PATH);
  fs.chmodSync(BIN_PATH, 0o755);
  logger.info("[ytmp3gg] yt-dlp_linux binary ready");
}

/**
 * Fetch the latest yt-dlp release tag from the GitHub API.
 * Returns null if the check fails (non-fatal).
 */
async function _fetchLatestYtdlpVersion() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path:     "/repos/yt-dlp/yt-dlp/releases/latest",
        method:   "GET",
        headers:  { "User-Agent": "boombox-bot/1.0", Accept: "application/json" },
        timeout:  10_000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(body).tag_name ?? null); }
          catch  { resolve(null); }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error",   () => resolve(null));
    req.end();
  });
}

// ── Core download logic ───────────────────────────────────────────────────────

/**
 * One download attempt with a specific set of extra args.
 * @private
 */
async function _attempt(input, type, quality, extraArgs, tmpDir, timeoutMs = 120_000, signal = undefined) {
  const outputTemplate = path.join(tmpDir, "audio.%(ext)s");
  const audioFmt = type === "mp4" ? "m4a" : "mp3";
  const audioQ   = type === "mp3" ? `${quality}K` : "0";

  const args = [
    "--ffmpeg-location", FFMPEG_PATH,
    "--no-playlist",
    "--extract-audio",
    "--audio-format",  audioFmt,
    "--audio-quality", audioQ,
    "--no-warnings",
    "--no-simulate",
    // Let yt-dlp itself retry transient network/fragment hiccups (timeouts,
    // connection resets) a couple of times BEFORE we give up on this method
    // and move to the next one — most "failures" that look like anti-bot
    // blocks are actually short-lived network blips, not a real block.
    "--extractor-retries", "2",
    "--fragment-retries",  "3",
    "--retry-sleep",       "1",
    "--print", "%(id)s|||%(title)s|||%(duration)s|||%(uploader)s|||%(thumbnail)s",
    "-o", outputTemplate,
    ...extraArgs,
    input,
  ];

  logger.debug(`[ytmp3gg] Args: ${args.join(" ")}`);

  const { stdout, stderr } = await execFileAsync(BIN_PATH, args, {
    timeout:   timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    signal,
  });

  if (stderr?.trim()) logger.debug(`[ytmp3gg] stderr: ${stderr.trim()}`);
  return stdout;
}

/** True when `err` is the result of an AbortSignal firing (job cancelled by
 * the caller — e.g. handler.js's outer stage timeout), not a real provider
 * failure. Must be checked before any fallback/retry decision: continuing
 * to try further methods after the whole job was already abandoned upstream
 * just wastes a slot's worth of CPU/network for no one. */
function _isAborted(err, signal) {
  return err?.name === "AbortError" || signal?.aborted === true;
}

/**
 * Parse yt-dlp stdout and locate the output file.
 * @private
 */
function _parseOutput(stdout, tmpDir, type, quality) {
  const metaLine  = stdout.split("\n").find(l => l.includes("|||")) ?? "";
  const [, rawTitle, rawDuration, rawUploader, rawThumb] = metaLine.split("|||");

  const title     = rawTitle?.trim()    || null;
  const duration  = rawDuration         ? parseInt(rawDuration, 10) : null;
  const uploader  = rawUploader?.trim() || null;
  const thumbnail = rawThumb?.trim()    || null;

  logger.info(`[ytmp3gg] Metadata | title="${title}" duration=${duration}s uploader="${uploader}"`);

  const files = fs.readdirSync(tmpDir);
  if (files.length === 0) throw new Error("yt-dlp selesai tapi tidak menghasilkan file output");

  const localFile = path.join(tmpDir, files[0]);
  const sizeKB    = (fs.statSync(localFile).size / 1024).toFixed(1);
  logger.info(`[ytmp3gg] ✅ File siap: ${localFile} (${sizeKB} KB)`);

  return { title, thumbnail, uploader, duration, type, quality: String(quality), localFile, tmpDir };
}

/**
 * Translate a raw yt-dlp error into a user-friendly Error.
 * @private
 */
function _translateError(err) {
  const raw   = (err.stderr || err.message || "").slice(0, 800);
  const lower = raw.toLowerCase();

  // Log the full, untruncated original output from yt-dlp BEFORE translating,
  // so the real root cause is always visible in the error log.
  const origStderr = (err.stderr ?? "").trim();
  const origStdout = (err.stdout ?? "").trim();
  const origParts  = [];
  if (origStderr) origParts.push(`stderr:\n${origStderr}`);
  if (origStdout) origParts.push(`stdout:\n${origStdout}`);
  if (!origStderr && !origStdout) origParts.push(`message:\n${err.message ?? ""}`);
  logger.error(`[ytmp3gg] Original Error:\n${origParts.join("\n\n")}`);

  if (err.killed || lower.includes("timed out") || err.code === "ETIMEDOUT")
    return new Error("Network timeout — download timed out (>120s), coba lagi nanti");
  if (lower.includes("unsupported url"))
    return new Error("Unsupported URL — link tidak dikenali oleh downloader, pastikan link valid dan publik");
  if (lower.includes("has been removed") || lower.includes("video_removed") || lower.includes("telah dihapus"))
    return new Error("Deleted Video — video ini telah dihapus oleh pembuatnya");
  if (lower.includes("video unavailable"))
    return new Error("Video tidak tersedia atau telah dihapus");
  if (lower.includes("private video") || lower.includes("this account is private"))
    return new Error("Private Video — video ini bersifat privat, tidak dapat diakses");
  // Anti-bot detection ("Sign in to confirm you're not a bot/robot") is
  // IP/client-fingerprint based, NOT a real login requirement — must be
  // checked BEFORE the generic "sign in" branch below and must NOT be
  // classified as a permanent failure, or the multi-method fallback loop
  // aborts after the very first player-client attempt instead of trying
  // the remaining ones (this was the root cause of most YouTube failures).
  if (lower.includes("not a bot") || lower.includes("not a robot") || lower.includes("confirm you're not"))
    return new Error("Anti-Bot Detection — YouTube meminta verifikasi bot pada client ini, mencoba metode lain...");
  if (lower.includes("sign in") || lower.includes("age-restricted"))
    return new Error("Video memerlukan login atau dibatasi usia");
  if (lower.includes("not found") || lower.includes("no such video"))
    return new Error("Video tidak ditemukan (404)");
  if (lower.includes("403") || lower.includes("forbidden"))
    return new Error("HTTP 403 — akses ditolak oleh server sumber");
  if (lower.includes("429") || lower.includes("too many requests"))
    return new Error("Rate limited (HTTP 429) — tunggu beberapa menit");
  if (lower.includes("not available in your country") || lower.includes("unavailable in your country") || lower.includes("blocked it in your country"))
    return new Error("Region Blocked — video tidak tersedia di wilayah server");
  if (lower.includes("copyright"))
    return new Error("Region Blocked — video diblokir karena klaim copyright");

  return new Error(`Download gagal: ${raw.slice(0, 200)}`);
}

/**
 * Returns true for errors where retrying with a different provider/args won't
 * help — the video itself is unavailable (deleted, private, region-locked, etc.)
 *
 * NOTE: Timeouts and network errors are intentionally NOT permanent — they are
 * transient failures that should trigger the multi-provider fallback chain.
 * Previously "timed out" was included here, which caused yt-dlp timeouts to
 * abort the entire fallback (ytdl-core and kaizenapi were never tried).
 */
function _isPermanentFailure(err) {
  const m = err.message.toLowerCase();
  return (
    m.includes("tidak tersedia")   ||
    m.includes("dihapus")          ||
    m.includes("privat")           ||
    m.includes("usia")             ||
    m.includes("login")            ||
    m.includes("region blocked")   ||
    m.includes("tidak ditemukan")
    // "timed out" / "network timeout" intentionally removed:
    // timeouts are transient and must trigger fallback to the next provider.
  );
}

// ── TikTok short-URL resolution ───────────────────────────────────────────────
//
// TikTok share links (vt.tiktok.com/xxx, vm.tiktok.com/xxx) are HTTP
// redirects. Without a convincing browser User-Agent/Referer, TikTok
// sometimes bounces the request to a generic https://www.tiktok.com/in/about
// landing page instead of the real video -- yt-dlp then fails with
// "Unsupported URL". Resolving the redirect ourselves first (with the right
// headers, and a retry with a second header set if the first bounces) avoids
// that failure mode before yt-dlp ever runs.

// Header set yang dirotasi saat resolving TikTok redirect.
// Set 1: Chrome desktop — paling umum berhasil untuk link biasa.
// Set 2: Chrome mobile Android — untuk link yang menolak desktop UA.
// Set 3: iOS Safari — untuk link share terbaru yang cek UA lebih ketat.
// Set 4: TikTok app (iOS) — untuk link vm./vt. yang butuh app UA.
const TIKTOK_UA_SETS = [
  {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer":         "https://www.tiktok.com/",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
  },
  {
    "User-Agent":      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
    "Referer":         "https://www.tiktok.com/",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
  {
    "User-Agent":      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Referer":         "https://www.tiktok.com/",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
  {
    "User-Agent":      "TikTok 29.9.3 rv:299301 (iPhone; iOS 16.6; en_US) Cronet",
    "Referer":         "https://www.tiktok.com/",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
];

function _isTikTokBouncePage(url) {
  try {
    const { hostname, pathname } = new URL(url);
    // Halaman utama tanpa video path
    if (pathname === "" || pathname === "/") return true;
    // Bounce ke halaman about / login / foryou / explore
    if (/^\/(in\/about|about|login|foryou|explore|trending|live)\/?$/i.test(pathname)) return true;
    // Redirect ke domain non-TikTok (misal: ke halaman login eksternal)
    if (!hostname.endsWith("tiktok.com")) return true;
    return false;
  } catch {
    return false;
  }
}

function _followRedirects(startUrl, headers, maxHops = 6) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    const step = (currentUrl) => {
      hops++;
      if (hops > maxHops) {
        reject(new Error("Terlalu banyak redirect saat resolve TikTok URL"));
        return;
      }
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch {
        reject(new Error(`URL TikTok tidak valid: ${currentUrl}`));
        return;
      }
      const req = https.request(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: "GET",
          agent: keepAliveAgent,
          headers,
          timeout: 10_000,
        },
        (res) => {
          res.resume(); // discard body — only headers matter here
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            step(new URL(res.headers.location, currentUrl).toString());
            return;
          }
          resolve(currentUrl);
        },
      );
      req.on("timeout", () => req.destroy(new Error("Timeout saat resolve TikTok URL")));
      req.on("error", reject);
      req.end();
    };
    step(startUrl);
  });
}

/**
 * Strip semua query parameter dari canonical TikTok video URL.
 *
 * TikTok share links dari Android/iPhone/Web menyertakan banyak parameter
 * tracking (_r, u_code, region, mid, preview_pb, sharer_language, _d,
 * share_item_id, utm_source, dll.) yang tidak diperlukan oleh yt-dlp dan
 * dapat membuat URL terlalu panjang atau memicu respons berbeda dari server.
 *
 * Hanya berlaku untuk URL canonical (@user/video/ID) — short domain
 * (vt./vm.) sudah di-resolve ke canonical sebelum fungsi ini dipanggil.
 *
 * @param {string} url
 * @returns {string}
 */
function _stripTikTokQueryParams(url) {
  try {
    const parsed = new URL(url);
    // Canonical video URL: tiktok.com/@user/video/ID  (www. atau m. atau bare)
    if (/\/@[^/]+\/video\/\d+/.test(parsed.pathname)) {
      const clean = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
      if (clean !== url) logger.debug(`[ytmp3gg] TikTok URL normalized: stripped ${[...parsed.searchParams.keys()].length} query params`);
      return clean;
    }
  } catch { /* malformed URL — leave as is */ }
  return url;
}

/**
 * Resolve a TikTok short/share link to its canonical video URL by following
 * redirects with browser-like headers, then strips all tracking query
 * parameters from the resolved URL before passing it to yt-dlp.
 *
 * Mendukung:
 *   - https://www.tiktok.com/@user/video/ID?utm_source=...  (long share link)
 *   - https://vt.tiktok.com/XXXXX/                          (short link)
 *   - https://vm.tiktok.com/XXXXX/                          (short link)
 *   - https://m.tiktok.com/@user/video/ID                   (mobile)
 *   - Share link Android / iPhone (semua dengan query param panjang)
 *
 * Falls back to the original URL if resolution fails (yt-dlp will try anyway).
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function resolveTikTokUrl(url) {
  if (!/tiktok\.com/i.test(url)) return url;

  // Untuk URL canonical yang sudah punya path @user/video/ID, tidak perlu
  // follow redirect — langsung strip query params saja.
  try {
    const parsed = new URL(url);
    const isCanonical =
      /^(www\.|m\.)?tiktok\.com$/i.test(parsed.hostname) &&
      /\/@[^/]+\/video\/\d+/.test(parsed.pathname);
    if (isCanonical) {
      const clean = _stripTikTokQueryParams(url);
      if (clean !== url) logger.info(`[ytmp3gg] TikTok canonical URL cleaned: ${url.slice(0, 80)}... → ${clean}`);
      return clean;
    }
  } catch { /* bad URL — fall through to redirect resolution */ }

  // URL pendek (vt./vm.) atau non-canonical — follow redirects.
  for (let i = 0; i < TIKTOK_UA_SETS.length; i++) {
    try {
      const resolved = await _followRedirects(url, TIKTOK_UA_SETS[i]);
      if (!_isTikTokBouncePage(resolved)) {
        const clean = _stripTikTokQueryParams(resolved);
        if (clean !== url) logger.info(`[ytmp3gg] TikTok short URL resolved: ${url} → ${clean}`);
        return clean;
      }
      logger.warn(`[ytmp3gg] TikTok resolve attempt ${i + 1} bounced to ${resolved} — retrying with different headers`);
    } catch (err) {
      logger.warn(`[ytmp3gg] TikTok resolve attempt ${i + 1} failed: ${err.message}`);
    }
  }

  // All attempts failed — strip params from original and let yt-dlp try.
  logger.warn(`[ytmp3gg] Could not resolve TikTok URL — passing stripped original to yt-dlp`);
  return _stripTikTokQueryParams(url);
}

// ── YouTube multi-method fallback ─────────────────────────────────────────────
//
// Root cause investigation (verified by hand against the live yt-dlp binary
// in this environment, not guessed from generic advice):
//
//   - yt-dlp's own DEFAULT extraction (no --extractor-args override) already
//     resolves to the "android_vr" client internally and returns full
//     audio-only formats (itags 139/140/249/251). This is the most reliable
//     path and was being wasted as "just try it first" instead of being
//     recognized as the real fix.
//   - Pinning `player_client=ios` or `player_client=mweb` explicitly is
//     CURRENTLY COUNTERPRODUCTIVE: both now require a GVS PO token this bot
//     cannot mint, so YouTube serves zero playable audio/video URLs for them
//     (storyboard images only) — every previous attempt on these clients was
//     guaranteed to fail before it even ran.
//   - `player_client=tv` hits YouTube's newer SABR-only signature-challenge
//     gate; even with a JS runtime installed (see below) it still returns no
//     playable formats in this environment.
//   - `player_client=tv_embedded` is no longer a recognized client at all —
//     yt-dlp silently ignores it and falls back to the same android_vr
//     default (so it was never doing anything beyond wasting a full attempt
//     + timeout).
//   - `player_client=android` (explicit) DOES still work, but only exposes
//     one muxed low-bitrate format (itag 18, ~44kbps) — worse quality than
//     default, but a real, working fallback if default ever fails.
//   - The missing-JS-runtime warning ("YouTube extraction without a JS
//     runtime has been deprecated") was real and has been fixed at the
//     system level by installing `deno` (see replit.md / environment setup)
//     so yt-dlp can solve signature/n-parameter challenges going forward.
//
// Net effect: the fallback list below only keeps methods verified to
// actually return playable formats, in order of quality — no more burning
// time on client pins that are guaranteed to fail right now.

const YOUTUBE_METHODS = [
  // ── Method 1: yt-dlp's own default (no override) — resolves to
  // android_vr internally, full audio-only formats, most reliable.
  [],

  // ── Method 2: android_vr pinned explicitly — insurance in case yt-dlp's
  // default client selection changes upstream; same working formats as
  // Method 1 without relying on "whatever the default currently is".
  [
    "--extractor-args", "youtube:player_client=android_vr",
  ],

  // ── Method 3: android client — verified working fallback, lower quality
  // (single muxed itag 18, ~44kbps) but real audio, not a guaranteed fail.
  [
    "--extractor-args", "youtube:player_client=android",
    "--add-headers", "User-Agent:com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
  ],
];

/** Per-method timeout — dipercepat agar fallback loop tidak memblok terlalu lama.
 * Early methods: 30s (cukup untuk download normal, gagal cepat jika terblokir).
 * Last method: 90s (budget penuh untuk koneksi lambat / file besar). */
function _methodTimeout(i) {
  return i < YOUTUBE_METHODS.length - 1 ? 30_000 : 90_000;
}

/**
 * Last-resort YouTube fallback using @distube/ytdl-core — a completely
 * separate implementation (its own signature/PO-token handling, its own
 * HTTP client) from yt-dlp. It fails for different reasons than yt-dlp, so
 * it recovers a real fraction of cases where every yt-dlp player-client
 * variant above was bot-gated or hit a signature-extraction regression.
 * @private
 */
// ytdl-core exposes no timeout option of its own on either getInfo() or the
// download stream -- both used to be able to hang forever on a stalled
// connection, silently freezing the "Download Audio" stage. Bound both
// explicitly; on timeout the stream/request is destroyed so the socket is
// actually released, not just abandoned.
const YTDL_CORE_INFO_TIMEOUT_MS     = 30_000;
const YTDL_CORE_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Pipes `stream` to `outputFile`, aborting both if nothing finishes within
 * `timeoutMs`. @private */
function _pipeStreamWithTimeout(stream, outputFile, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputFile);
    const timer = setTimeout(() => {
      const err = new Error(`ytdl-core audio download timed out (>${timeoutMs / 1000}s)`);
      stream.destroy?.(err);
      file.destroy();
      reject(err);
    }, timeoutMs);
    const settle = (fn) => (arg) => { clearTimeout(timer); onAbort && signal?.removeEventListener("abort", onAbort); fn(arg); };
    const onAbort = () => {
      const err = new Error("Dibatalkan (timeout tahap)"); err.name = "AbortError";
      stream.destroy?.(err);
      file.destroy();
      settle(reject)(err);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    stream.on("error", settle(reject));
    file.on("error", settle(reject));
    file.on("finish", settle(resolve));
    stream.pipe(file);
  });
}

async function _ytdlCoreFallback(input, type, quality, tmpDir, onProgress, signal) {
  logger.info(`[ytmp3gg] YouTube — trying fallback engine (@distube/ytdl-core)`);
  await onProgress?.("Recovering download...");

  if (signal?.aborted) { const e = new Error("Dibatalkan (timeout tahap)"); e.name = "AbortError"; throw e; }

  const info = await _withTimeout(
    ytdlCore.getInfo(input, {
      requestOptions: {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
      },
    }),
    YTDL_CORE_INFO_TIMEOUT_MS,
    `ytdl-core getInfo timed out (>${YTDL_CORE_INFO_TIMEOUT_MS / 1000}s)`,
  );

  const ext        = "m4a";
  const outputFile = path.join(tmpDir, `audio.${ext}`);
  const stream      = ytdlCore.downloadFromInfo(info, { quality: "highestaudio", filter: "audioonly" });

  await _pipeStreamWithTimeout(stream, outputFile, YTDL_CORE_DOWNLOAD_TIMEOUT_MS, signal);

  // Transcode to the requested output format/quality with ffmpeg, matching
  // what the yt-dlp path produces, so downstream code (top4top upload,
  // embeds) sees a consistent file type either way.
  const audioFmt   = type === "mp4" ? "m4a" : "mp3";
  const audioQ     = type === "mp3" ? `${quality}k` : undefined;
  const finalFile  = path.join(tmpDir, `audio_final.${audioFmt}`);
  const ffmpegArgs = ["-y", "-i", outputFile, "-vn"];
  if (audioQ) ffmpegArgs.push("-b:a", audioQ);
  ffmpegArgs.push(finalFile);

  await execFileAsync(FFMPEG_PATH, ffmpegArgs, { timeout: 60_000, signal });
  try { fs.unlinkSync(outputFile); } catch {}

  const details  = info.videoDetails ?? {};
  const title     = details.title || null;
  const duration  = details.lengthSeconds ? parseInt(details.lengthSeconds, 10) : null;
  const uploader  = details.author?.name || null;
  const thumbnail = details.thumbnails?.at(-1)?.url || null;

  const sizeKB = (fs.statSync(finalFile).size / 1024).toFixed(1);
  logger.info(`[ytmp3gg] ✅ Fallback engine succeeded | title="${title}" (${sizeKB} KB)`);

  return { title, thumbnail, uploader, duration, type, quality: String(quality), localFile: finalFile, tmpDir };
}

async function _ytdlYouTube(input, type, quality, onProgress, signal) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-"));
  let   lastError = new Error("YouTube download gagal setelah semua metode dicoba");

  // ── Provider 1: yt-dlp (Utama) ────────────────────────────────────────────
  // Health-checked: if this provider has failed 5x in a row recently, skip
  // straight to the backups instead of burning time retrying a client we
  // already know is currently blocked/broken.
  if (providerHealth.shouldSkip("yt-dlp-youtube")) {
    logger.warn(`[ytmp3gg] Provider: yt-dlp (YouTube) | Status: OFFLINE | Action: Switch → ytdl-core`);
    lastError = new Error("yt-dlp sedang OFFLINE (5x gagal berturut-turut) — mencoba provider cadangan");
  } else {
    for (let i = 0; i < YOUTUBE_METHODS.length; i++) {
      if (signal?.aborted) { lastError = new Error("Dibatalkan (timeout tahap)"); lastError.name = "AbortError"; break; }
      if (i > 0) {
        try {
          for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
        } catch {}
        await onProgress?.("Trying another method...");
      }

      logger.info(`[ytmp3gg] YouTube — trying method ${i + 1}/${YOUTUBE_METHODS.length}`);
      try {
        const stdout = await _attempt(input, type, quality, YOUTUBE_METHODS[i], tmpDir, _methodTimeout(i), signal);
        logger.info(`[ytmp3gg] YouTube method ${i + 1} succeeded — stopping fallback loop`);
        providerHealth.recordSuccess("yt-dlp-youtube");
        return _parseOutput(stdout, tmpDir, type, quality);
      } catch (err) {
        if (_isAborted(err, signal)) { lastError = err; break; }
        lastError = _translateError(err);
        logger.warn(`[ytmp3gg] Provider: yt-dlp (YouTube) | Method: ${i + 1}/${YOUTUBE_METHODS.length} | Status: FAILED | Reason: ${lastError.message}`);

        if (_isPermanentFailure(lastError)) {
          logger.info(`[ytmp3gg] Permanent failure — stopping YouTube fallback`);
          break;
        }
        if (i < YOUTUBE_METHODS.length - 1) {
          logger.info(`[ytmp3gg] Action: Switch → yt-dlp method ${i + 2}/${YOUTUBE_METHODS.length}`);
        }
      }
    }

    // Permanent failures (deleted/private/region-blocked) are a real
    // per-video outcome, not a provider health problem — don't count them
    // against yt-dlp's health. Anti-bot/timeout/network-style failures DO
    // count, since those indicate the provider itself is currently struggling.
    if (!_isAborted(lastError, signal) && !(_isPermanentFailure(lastError) && !lastError.message.includes("Anti-Bot"))) {
      providerHealth.recordFailure("yt-dlp-youtube", { reason: lastError.message, isTimeout: lastError.message.toLowerCase().includes("timeout") });
    }
  }

  if (_isAborted(lastError, signal)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw lastError;
  }

  // All yt-dlp player-client variants failed (or hit a permanent failure) —
  // try the independent ytdl-core engine before giving up entirely, unless
  // the failure is a real permanent one (deleted/private/region-blocked),
  // where a different engine won't change the outcome.
  if (_isPermanentFailure(lastError) && !lastError.message.includes("Anti-Bot")) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw lastError;
  }

  try {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
  } catch {}

  // ── Backup API 1: @distube/ytdl-core ──────────────────────────────────────
  if (providerHealth.shouldSkip("ytdl-core")) {
    logger.warn(`[ytmp3gg] Provider: ytdl-core | Status: OFFLINE | Action: Switch → Kaizen API`);
  } else if (!signal?.aborted) {
    logger.info(`[ytmp3gg] Provider: yt-dlp (YouTube) | Status: FAILED | Action: Switch → ytdl-core`);
    try {
      const result = await _ytdlCoreFallback(input, type, quality, tmpDir, onProgress, signal);
      providerHealth.recordSuccess("ytdl-core");
      logger.info(`[ytmp3gg] Provider: ytdl-core | Status: SUCCESS | Fallback: YES`);
      return result;
    } catch (err) {
      if (_isAborted(err, signal)) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} throw err; }
      logger.warn(`[ytmp3gg] Provider: ytdl-core | Status: FAILED | Reason: ${err.message} | Action: Switch → Kaizen API`);
      providerHealth.recordFailure("ytdl-core", { reason: err.message, isTimeout: err.message.toLowerCase().includes("timeout") });
    }
  }

  // ── Backup API 2 (last resort): kaizenapi.my.id ───────────────────────────
  // Menggunakan endpoint baru (kaizenapi.my.id/downloader/youtube) dari file referensi,
  // dengan fallback ke endpoint lama (api.kaizenapi.my.id/ytmp3).
  // Hanya dicoba jika SEMUA provider di atas gagal.
  try {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
  } catch {}

  if (providerHealth.shouldSkip("kaizenapi")) {
    logger.warn(`[ytmp3gg] Provider: Kaizen API | Status: OFFLINE | Action: Seluruh provider gagal, BoomBox Failed`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw lastError;
  }
  if (signal?.aborted) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const abortErr = new Error("Dibatalkan (timeout tahap)"); abortErr.name = "AbortError"; throw abortErr;
  }

  try {
    await onProgress?.("Trying alternative API...");
    logger.info(`[ytmp3gg] Provider: Kaizen API | Status: Trying | Endpoint: kaizenapi.my.id/downloader/youtube`);
    const result = await kaizenDownload(input, type, quality, tmpDir, signal);
    providerHealth.recordSuccess("kaizenapi");
    logger.info(`[ytmp3gg] Provider: Kaizen API | Status: SUCCESS | Fallback: YES`);
    return result;
  } catch (kaizenErr) {
    if (_isAborted(kaizenErr, signal)) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} throw kaizenErr; }
    logger.warn(`[ytmp3gg] Provider: Kaizen API | Status: FAILED | Reason: ${kaizenErr.message} | Action: Switch → Piped`);
    providerHealth.recordFailure("kaizenapi", { reason: kaizenErr.message, isTimeout: kaizenErr.message.toLowerCase().includes("timeout") });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // ── Backup API 3: Piped (public YouTube frontend API) ─────────────────────
  // Resolves audio stream URLs without bot detection by using Piped public instances.
  // The resolved URL is then downloaded directly via yt-dlp to handle format conversion.
  if (!signal?.aborted) {
    const pipedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-piped-"));
    try {
      await onProgress?.("Trying Piped API...");
      logger.info(`[ytmp3gg] Provider: Piped | Status: Trying`);
      const result = await _pipedFallback(input, type, quality, pipedTmpDir, onProgress, signal);
      logger.info(`[ytmp3gg] Provider: Piped | Status: SUCCESS | Fallback: YES`);
      return result;
    } catch (pipedErr) {
      if (_isAborted(pipedErr, signal)) { try { fs.rmSync(pipedTmpDir, { recursive: true, force: true }); } catch {} const ae = new Error("Dibatalkan (timeout tahap)"); ae.name = "AbortError"; throw ae; }
      logger.warn(`[ytmp3gg] Provider: Piped | Status: FAILED | Reason: ${pipedErr.message} | Action: Switch → Invidious`);
      try { fs.rmSync(pipedTmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Backup API 4: Invidious (public YouTube alternative API) ──────────────
  // Another independent implementation that bypasses the main YouTube API entirely.
  if (!signal?.aborted) {
    const invTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-inv-"));
    try {
      await onProgress?.("Trying Invidious API...");
      logger.info(`[ytmp3gg] Provider: Invidious | Status: Trying`);
      const result = await _invidiousFallback(input, type, quality, invTmpDir, onProgress, signal);
      logger.info(`[ytmp3gg] Provider: Invidious | Status: SUCCESS | Fallback: YES`);
      return result;
    } catch (invErr) {
      if (_isAborted(invErr, signal)) { try { fs.rmSync(invTmpDir, { recursive: true, force: true }); } catch {} const ae = new Error("Dibatalkan (timeout tahap)"); ae.name = "AbortError"; throw ae; }
      logger.warn(`[ytmp3gg] Provider: Invidious | Status: FAILED | Reason: ${invErr.message} | Action: Seluruh provider habis, BoomBox Failed`);
      try { fs.rmSync(invTmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  throw lastError;
}

// ── Piped API fallback ────────────────────────────────────────────────────────
// Fetches the audio stream URL from public Piped instances (piped.video / kavin.rocks)
// and downloads with yt-dlp using the resolved URL, bypassing YouTube bot detection.

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://piped-api.garudalinux.org",
  "https://pipedapi.in",
];

function _extractYouTubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m?.[1] ?? null;
}

async function _pipedFallback(input, type, quality, tmpDir, onProgress, signal) {
  const videoId = _extractYouTubeId(input);
  if (!videoId) throw new Error("Piped: could not extract YouTube video ID");

  let audioUrl = null;
  let videoTitle = null;

  for (const instance of PIPED_INSTANCES) {
    if (signal?.aborted) break;
    try {
      const res = await _withTimeout(
        fetch(`${instance}/streams/${videoId}`, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; BoomBox/1.0)" },
          signal,
        }),
        12_000,
        "Piped API request timed out",
      );
      if (!res.ok) continue;
      const data = await res.json();
      videoTitle = data.title ?? null;
      const streams = (data.audioStreams ?? [])
        .filter(s => s.mimeType && (s.mimeType.includes("audio") || s.mimeType.includes("mp4a")))
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      if (streams[0]?.url) { audioUrl = streams[0].url; break; }
    } catch (e) {
      logger.warn(`[ytmp3gg] Piped instance ${instance} failed: ${e.message}`);
    }
  }

  if (!audioUrl) throw new Error("Piped: no audio stream URL found on any instance");

  // Download the resolved stream URL directly with yt-dlp
  const audioFmt = type === "mp4" ? "m4a" : "mp3";
  const audioQ   = type === "mp3" ? `${quality}K` : "0";
  const outTpl   = path.join(tmpDir, `audio.%(ext)s`);

  const args = [
    "--ffmpeg-location", FFMPEG_PATH,
    "--no-playlist",
    "--extract-audio",
    "--audio-format",  audioFmt,
    "--audio-quality", audioQ,
    "--no-warnings",
    "--no-simulate",
    "-o", outTpl,
    audioUrl,
  ];

  const { stdout } = await execFileAsync(BIN_PATH, args, {
    timeout:   120_000,
    maxBuffer: 1 * 1024 * 1024,
  });

  const files = fs.readdirSync(tmpDir).filter(f => /^audio\./.test(f));
  if (files.length === 0) throw new Error("Piped: no output file produced by yt-dlp");

  return {
    localFile: path.join(tmpDir, files[0]),
    tmpDir,
    title:    videoTitle,
    thumbnail: null,
    uploader:  "Piped",
    duration:  null,
    type,
    quality,
  };
}

// ── Invidious API fallback ────────────────────────────────────────────────────
// Fetches audio stream URLs from public Invidious instances.

const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.snopyta.org",
  "https://vid.puffyan.us",
  "https://invidious.tiekoetter.com",
];

async function _invidiousFallback(input, type, quality, tmpDir, onProgress, signal) {
  const videoId = _extractYouTubeId(input);
  if (!videoId) throw new Error("Invidious: could not extract YouTube video ID");

  let audioUrl = null;

  for (const instance of INVIDIOUS_INSTANCES) {
    if (signal?.aborted) break;
    try {
      const res = await _withTimeout(
        fetch(`${instance}/api/v1/videos/${videoId}?fields=adaptiveFormats,title`, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; BoomBox/1.0)" },
          signal,
        }),
        12_000,
        "Invidious API request timed out",
      );
      if (!res.ok) continue;
      const data = await res.json();
      const formats = (data.adaptiveFormats ?? [])
        .filter(f => (f.type ?? "").includes("audio"))
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
      if (formats[0]?.url) { audioUrl = formats[0].url; break; }
    } catch (e) {
      logger.warn(`[ytmp3gg] Invidious instance ${instance} failed: ${e.message}`);
    }
  }

  if (!audioUrl) throw new Error("Invidious: no audio stream URL found on any instance");

  const audioFmt = type === "mp4" ? "m4a" : "mp3";
  const audioQ   = type === "mp3" ? `${quality}K` : "0";
  const outTpl   = path.join(tmpDir, `audio.%(ext)s`);

  const args = [
    "--ffmpeg-location", FFMPEG_PATH,
    "--no-playlist",
    "--extract-audio",
    "--audio-format",  audioFmt,
    "--audio-quality", audioQ,
    "--no-warnings",
    "--no-simulate",
    "-o", outTpl,
    audioUrl,
  ];

  const { stdout } = await execFileAsync(BIN_PATH, args, {
    timeout:   120_000,
    maxBuffer: 1 * 1024 * 1024,
  });

  const files = fs.readdirSync(tmpDir).filter(f => /^audio\./.test(f));
  if (files.length === 0) throw new Error("Invidious: no output file produced by yt-dlp");

  return {
    localFile: path.join(tmpDir, files[0]),
    tmpDir,
    title:    null,
    thumbnail: null,
    uploader:  "Invidious",
    duration:  null,
    type,
    quality,
  };
}

// ── TikTok multi-method fallback ──────────────────────────────────────────────
//
// Each element is an array of extra args appended to the base yt-dlp command.
// Methods are tried in order; the first to succeed wins.

const TIKTOK_METHODS = [
  // ── Method 1: Standard ── no special flags
  [],

  // ── Method 2: Skip cert check + Chrome desktop UA + TikTok Referer
  [
    "--no-check-certificates",
    "--add-headers", "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "--add-headers", "Referer:https://www.tiktok.com/",
  ],

  // ── Method 3: Force m4a/bestaudio, skip cert, mobile UA
  [
    "--no-check-certificates",
    "--format", "bestaudio[ext=m4a]/bestaudio/best",
    "--add-headers", "User-Agent:Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
    "--add-headers", "Referer:https://www.tiktok.com/",
  ],

  // ── Method 4: Extended retries within yt-dlp + different UA
  [
    "--no-check-certificates",
    "--extractor-retries", "5",
    "--fragment-retries", "5",
    "--retry-sleep", "exponential=1:2",
    "--add-headers", "User-Agent:TikTok/26.2.3 (iPhone; iOS 16.6; Scale/3.00)",
    "--add-headers", "Referer:https://www.tiktok.com/",
  ],

  // ── Method 5: Compat mode — broadest format selection, no cert, verbose for debugging
  [
    "--no-check-certificates",
    "--format", "worstaudio/worst/best",
    "--compat-options", "no-youtube-unavailable-videos",
    "--add-headers", "User-Agent:Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  ],
];

async function _ytdlTikTok(input, type, quality, onProgress, signal) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-"));
  let   lastError = new Error("TikTok download gagal setelah semua metode dicoba");

  if (providerHealth.shouldSkip("yt-dlp-tiktok")) {
    logger.warn(`[ytmp3gg] yt-dlp (TikTok) is OFFLINE (health check) — no TikTok backup available`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw new Error("yt-dlp sedang OFFLINE (5x gagal berturut-turut) untuk TikTok — coba lagi dalam beberapa menit");
  }

  for (let i = 0; i < TIKTOK_METHODS.length; i++) {
    if (signal?.aborted) { lastError = new Error("Dibatalkan (timeout tahap)"); lastError.name = "AbortError"; break; }
    // Clean partial files from the previous failed attempt
    if (i > 0) {
      try {
        for (const f of fs.readdirSync(tmpDir)) {
          fs.unlinkSync(path.join(tmpDir, f));
        }
      } catch {}
      await onProgress?.("Trying another method...");
    }

    logger.info(`[ytmp3gg] TikTok — trying method ${i + 1}/${TIKTOK_METHODS.length}`);
    try {
      const stdout = await _attempt(input, type, quality, TIKTOK_METHODS[i], tmpDir, 120_000, signal);
      providerHealth.recordSuccess("yt-dlp-tiktok");
      return _parseOutput(stdout, tmpDir, type, quality);
    } catch (err) {
      if (_isAborted(err, signal)) { lastError = err; break; }
      lastError = _translateError(err);
      logger.warn(`[ytmp3gg] TikTok method ${i + 1} failed: ${lastError.message}`);

      if (_isPermanentFailure(lastError)) {
        logger.info(`[ytmp3gg] Permanent failure — stopping TikTok fallback`);
        break;
      }
    }
  }

  if (!_isAborted(lastError, signal) && !_isPermanentFailure(lastError)) {
    providerHealth.recordFailure("yt-dlp-tiktok", { reason: lastError.message, isTimeout: lastError.message.toLowerCase().includes("timeout") });
  }

  // All methods exhausted — clean up and throw
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  throw lastError;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Download audio (or video) from a YouTube or TikTok URL.
 *
 * @param {string} input           Full URL
 * @param {"mp3"|"mp4"} type
 * @param {string|number} quality  Audio bitrate in kbps (128/320) or video resolution
 * @param {(label: string) => (void|Promise<void>)} [onProgress]  Optional callback
 *   invoked with a short human-readable status ("Trying another method...",
 *   "Recovering download...") whenever the retry loop advances — lets the
 *   caller edit the same Discord status message instead of guessing state.
 * @param {AbortSignal} [signal]  Optional — when aborted, all in-flight
 *   exec/http calls for this request are killed immediately (not just
 *   abandoned) so a caller-side timeout can never leave a zombie process or
 *   socket behind. See handler.js's withStageTimeout().
 * @returns {Promise<{ title, thumbnail, uploader, duration, type, quality, localFile, tmpDir }>}
 */
export async function ytdl(input, type = "mp3", quality = "128", onProgress = null, signal = undefined) {
  // FIX: wrap ensureBinary() so a missing/undownloadable binary does NOT abort
  // the entire download pipeline. When the binary is unavailable, yt-dlp
  // providers are already marked OFFLINE by ensureBinary()'s catch block, so
  // _ytdlYouTube/_ytdlTikTok will skip straight to backup providers (ytdl-core,
  // kaizenapi) that don't need the binary at all. Previously this bare await
  // let the throw propagate up and kill the job before backups were tried.
  try {
    await ensureBinary();
  } catch (err) {
    logger.warn(`[ytmp3gg] ytdl: binary unavailable — yt-dlp will be skipped, backup providers will handle this (${err.message})`);
    // Continue — _ytdlYouTube/_ytdlTikTok will see yt-dlp-* as OFFLINE and fall through to backups.
  }

  const isTikTok = /tiktok\.com/i.test(input);
  const resolvedInput = isTikTok ? await resolveTikTokUrl(input) : input;

  logger.info(`[ytmp3gg] ▶ Starting download | url="${resolvedInput}" type=${type} quality=${quality}`);

  if (isTikTok) {
    return _ytdlTikTok(resolvedInput, type, quality, onProgress, signal);
  }

  return _ytdlYouTube(resolvedInput, type, quality, onProgress, signal);
}

// ── Metadata-only pre-check (no download) ────────────────────────────────────

/**
 * Fetch video metadata WITHOUT downloading.
 * Uses --simulate — fast (~3s). Works for both YouTube and TikTok.
 *
 * @param {string} url
 * @returns {Promise<{ title: string|null, duration: number|null, thumbnail: string|null, uploader: string|null }>}
 */
export async function getVideoInfo(url) {
  const isTikTok = /tiktok\.com/i.test(url);

  // FIX: health check BEFORE ensureBinary() so a missing/downloading binary
  // never blocks the metadata fetch when yt-dlp is already known-bad.
  // Previously ensureBinary() ran first — if it threw (download timeout), the
  // health check was never reached and getVideoInfo() crashed the pipeline
  // instead of returning nulls (which the handler treats as non-fatal).
  const healthKey = isTikTok ? "yt-dlp-tiktok" : "yt-dlp-youtube";
  if (providerHealth.shouldSkip(healthKey)) {
    logger.warn(`[ytmp3gg] getVideoInfo: ${healthKey} is OFFLINE — skipping metadata fetch, proceeding to download`);
    return { duration: null, title: null, thumbnail: null, uploader: null };
  }

  // Binary check only if yt-dlp is ONLINE and we're going to use it.
  // If unavailable (download failed), return nulls — non-fatal; the real
  // ytdl() download call has its own full multi-provider fallback.
  try {
    await ensureBinary();
  } catch (err) {
    logger.warn(`[ytmp3gg] getVideoInfo: binary unavailable — skipping yt-dlp metadata (${err.message})`);
    return { duration: null, title: null, thumbnail: null, uploader: null };
  }

  const resolvedUrl = isTikTok ? await resolveTikTokUrl(url) : url;
  logger.debug(`[ytmp3gg] getVideoInfo (simulate) | url="${resolvedUrl}"`);

  // TikTok simulate also benefits from the extra headers.
  // YouTube gets a couple of client fallbacks too — a bot-gated metadata
  // fetch is non-fatal (the real ytdl() download call has its own full
  // fallback loop), but skipping the fallback here would needlessly lose
  // duration/thumbnail info that yt-dlp could otherwise recover in one try.
  const infoMethods = isTikTok
    ? [[
        "--no-check-certificates",
        "--add-headers", "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "--add-headers", "Referer:https://www.tiktok.com/",
      ]]
    : [
        [], // yt-dlp default combo first
        ["--extractor-args", "youtube:player_client=tv"],
      ];

  for (let i = 0; i < infoMethods.length; i++) {
    const args = [
      "--no-playlist",
      "--simulate",
      "--no-warnings",
      "--extractor-retries", "1",
      "--print", "%(duration)s|||%(title)s|||%(thumbnail)s|||%(uploader)s",
      ...infoMethods[i],
      resolvedUrl,
    ];

    try {
      const { stdout } = await execFileAsync(BIN_PATH, args, {
        timeout:   8_000, // 8s — metadata fetch harus cepat; gagal cepat → download tetap jalan
        maxBuffer: 1 * 1024 * 1024,
      });
      const line            = stdout.trim().split("\n").find(l => l.includes("|||")) ?? "";
      const [rawDur, rawTitle, rawThumb, rawUp] = line.split("|||");
      const duration = rawDur && !isNaN(rawDur) ? parseInt(rawDur, 10) : null;
      return {
        duration,
        title:     rawTitle?.trim() || null,
        thumbnail: rawThumb?.trim() || null,
        uploader:  rawUp?.trim()    || null,
      };
    } catch (err) {
      logger.warn(`[ytmp3gg] getVideoInfo method ${i + 1}/${infoMethods.length} failed: ${err.message}`);
    }
  }

  // All methods failed — non-fatal, caller treats null duration as "unknown,
  // proceed anyway" and the real ytdl() download call still gets its own
  // full multi-method fallback.
  return { duration: null, title: null, thumbnail: null, uploader: null };
}
