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

import { execFile, execSync } from "node:child_process";
import { promisify }          from "node:util";
import fs                     from "node:fs";
import path                   from "node:path";
import os                     from "node:os";
import https                  from "node:https";
import { fileURLToPath }      from "node:url";
import ytdlCore                from "@distube/ytdl-core";
import { kaizenDownload }      from "./kaizenDownloader.js";
import { logger }              from "../utils/logger.js";
import * as providerHealth     from "./providerHealth.js";
import { FFMPEG_PATH, ffmpegAvailable } from "../utils/ffmpegPath.js";
import { COOKIES_ARGS, hasCookies }     from "../utils/cookiesResolver.js";
import { ENV_INFO }                     from "../utils/envDetector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR   = path.join(__dirname, "..", "..", "bin");

// ── Platform-aware yt-dlp binary resolution ───────────────────────────────────
//
// Supports Railway, Replit, Pterodactyl/Pyrodele panels, VPS (Ubuntu/Debian),
// and any standard Linux host — without changing source code between platforms.
//
// Resolution order at module load:
//   1. System yt-dlp in PATH (Pterodactyl panels with pip-installed yt-dlp,
//      VPS with yt-dlp from apt/pip — most common on managed hosting panels)
//   2. bin/yt-dlp_{platform}  (committed binary for this exact OS + arch)
//   3. bin/yt-dlp             (generic committed fallback)
//   4. Not found yet          (will be downloaded at startup to bin/yt-dlp_{platform})
//
// When a SYSTEM binary is detected we set _USE_SYSTEM_YTDLP = true, which:
//   • Skips the download step entirely (system admin owns the binary)
//   • Skips the GitHub auto-update check (same reason)
//   • Still verifies the binary runs and logs its version
//
function _detectPlatformSuffix() {
  const { platform, arch } = process;
  if (platform === "win32")  return "yt-dlp.exe";
  if (platform === "darwin") return "yt-dlp_macos";
  if (arch === "arm64" || arch === "aarch64") return "yt-dlp_linux_aarch64";
  if (arch === "arm")        return "yt-dlp_linux_armv7l";
  return "yt-dlp_linux"; // Linux x64 — Railway, Replit, most VPS/panel hosts
}

const _PLATFORM_SUFFIX = _detectPlatformSuffix();
const YTDLP_DL         = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${_PLATFORM_SUFFIX}`;

// True when yt-dlp comes from the system PATH (managed by host/admin).
// Downloads and auto-updates are disabled when this is true.
let _USE_SYSTEM_YTDLP = false;

// BIN_PATH is `let` so it can be set to the system binary path when found.
// All callers reference this variable — no code change needed elsewhere.
let BIN_PATH = (() => {
  // 1. System yt-dlp in PATH (Pterodactyl, pip-installed VPS, etc.)
  try {
    const sys = execSync("which yt-dlp", {
      encoding: "utf8",
      stdio:    ["pipe", "pipe", "pipe"],
    }).trim();
    if (sys && fs.existsSync(sys)) {
      _USE_SYSTEM_YTDLP = true;
      logger.info(`[ytmp3gg] yt-dlp found in system PATH: ${sys} — skipping auto-download/update`);
      return sys;
    }
  } catch { /* not in PATH */ }

  // 2. Platform-specific committed binary (e.g. bin/yt-dlp_linux)
  const platformBin = path.join(BIN_DIR, _PLATFORM_SUFFIX);
  if (fs.existsSync(platformBin)) {
    logger.info(`[ytmp3gg] Using committed binary (${_PLATFORM_SUFFIX}): ${platformBin}`);
    return platformBin;
  }

  // 3. Generic committed binary (bin/yt-dlp — works if committed without suffix)
  const genericBin = path.join(BIN_DIR, "yt-dlp");
  if (fs.existsSync(genericBin)) {
    logger.info(`[ytmp3gg] Using generic committed binary: ${genericBin}`);
    return genericBin;
  }

  // 4. Binary not found — will be downloaded to this path at startup
  logger.warn(`[ytmp3gg] yt-dlp not found — will auto-download to: ${platformBin}`);
  return platformBin;
})();

// Log startup context once (env name + platform info set by envDetector.js)
logger.info(`[ytmp3gg] Environment: ${ENV_INFO.name} | ${ENV_INFO.platform}/${ENV_INFO.arch} | Node ${ENV_INFO.node} | cookies=${hasCookies}`);

const execFileAsync = promisify(execFile);

// FFMPEG_PATH and ffmpegAvailable are resolved once at startup by
// ffmpegPath.js: system ffmpeg → ffmpeg-static bundle → "ffmpeg" fallback.
// See src/utils/ffmpegPath.js for resolution order.

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
  // ── System-managed binary (Pterodactyl, pip-installed VPS) ────────────────
  // We don't own this binary, so we only verify it runs — no download/update.
  if (_USE_SYSTEM_YTDLP) {
    try {
      const { stdout } = await execFileAsync(BIN_PATH, ["--version"], { timeout: 10_000 });
      logger.info(`[ytmp3gg] System yt-dlp ready: v${stdout.trim()}`);
    } catch (e) {
      logger.warn(`[ytmp3gg] System yt-dlp version check failed: ${e.message} — will still attempt to use it`);
    }
    return;
  }

  // ── Bot-managed binary (downloaded / committed) ───────────────────────────
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
  // System-managed binary — always present, nothing to download or verify.
  if (_USE_SYSTEM_YTDLP) return;

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
  logger.info(`[ytmp3gg] Downloading ${_PLATFORM_SUFFIX} from GitHub...`);
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
    ...COOKIES_ARGS,      // YouTube cookies for anti-bot bypass ([] when not available)
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
function _parseOutput(stdout, tmpDir, type, quality, provider = "yt-dlp") {
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

  return { title, thumbnail, uploader, duration, type, quality: String(quality), localFile, tmpDir, provider };
}

/**
 * Translate a raw yt-dlp error into a user-friendly Error.
 * Each returned Error carries a `.priority` property (1–9, higher = more
 * informative/specific) so the caller can pick the best error to surface to
 * the user when multiple providers all fail.
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

  const make = (msg, priority) => Object.assign(new Error(msg), { priority });

  // ── Timeout / network ── priority 4 (transient, informative)
  if (err.killed || err.code === "ETIMEDOUT" ||
      lower.includes("timed out") || lower.includes("etimedout") ||
      lower.includes("connection reset") || lower.includes("econnreset"))
    return make("Network timeout — download timed out, coba lagi nanti", 4);

  // ── ffmpeg missing — priority 8 (specific, actionable)
  // yt-dlp exits with a clear message when it can't find ffmpeg.
  if (lower.includes("ffmpeg") && (lower.includes("not found") || lower.includes("no such file") || lower.includes("not installed") || lower.includes("couldn't find")))
    return make("FFmpeg belum tersedia pada server — audio conversion tidak dapat dilakukan", 8);

  // ── DRM protected — priority 8
  if (lower.includes("drm") || lower.includes("widevine") || lower.includes("encrypted") || lower.includes("protection system"))
    return make("DRM Protected — video ini dilindungi DRM dan tidak dapat diunduh", 8);

  // ── Live stream — priority 8
  if (lower.includes("is a live event") || lower.includes("live stream") || lower.includes("is currently live") ||
      lower.includes("live_broadcast") || lower.includes("is live") || lower.includes("premieres"))
    return make("Live Stream — video ini adalah siaran langsung dan tidak dapat diunduh", 8);

  // ── Truly deleted — priority 9
  if (lower.includes("has been removed") || lower.includes("video_removed") || lower.includes("telah dihapus"))
    return make("Deleted Video — video ini telah dihapus oleh pembuatnya", 9);

  // ── Private video — priority 9
  if (lower.includes("private video") || lower.includes("this account is private") || lower.includes("this video is private"))
    return make("Private Video — video ini bersifat privat, tidak dapat diakses", 9);

  // ── Anti-bot detection — priority 7
  // MUST be checked BEFORE the generic "sign in" branch below.
  // "Sign in to confirm you're not a bot" is an IP/client-fingerprint challenge —
  // NOT a real login requirement. Translating it as "needs login" would classify
  // it as a permanent failure and abort the entire multi-method fallback chain.
  if (lower.includes("not a bot") || lower.includes("not a robot") ||
      lower.includes("confirm you're not") || lower.includes("confirm that you're not"))
    return make("Anti-Bot Detection — YouTube meminta verifikasi bot pada client ini, mencoba metode lain...", 7);

  // ── Age-restricted / sign-in required — priority 8
  if (lower.includes("age-restricted") || lower.includes("age restricted"))
    return make("Age Restricted — video ini dibatasi usia dan memerlukan login", 8);

  if (lower.includes("sign in") || lower.includes("log in") || lower.includes("login required"))
    return make("Video memerlukan login — tidak dapat diakses tanpa akun", 8);

  // ── Unsupported URL — priority 6
  if (lower.includes("unsupported url"))
    return make("Unsupported URL — link tidak dikenali oleh downloader, pastikan link valid dan publik", 6);

  // ── "Video unavailable" — priority 3 (ambiguous: could be PO-token rejection)
  // Kept LOW priority so anti-bot / specific errors win when multiple providers fail.
  if (lower.includes("video unavailable"))
    return make("Video tidak tersedia — mungkin karena pembatasan akses oleh YouTube", 3);

  // ── HTTP 403 — priority 5
  if (lower.includes("403") || lower.includes("forbidden"))
    return make("HTTP 403 — akses ditolak oleh server sumber", 5);

  // ── Rate limited — priority 6
  if (lower.includes("429") || lower.includes("too many requests"))
    return make("Rate limited (HTTP 429) — tunggu beberapa menit", 6);

  // ── Region blocked — priority 8
  if (lower.includes("not available in your country") || lower.includes("unavailable in your country") ||
      lower.includes("blocked it in your country"))
    return make("Region Blocked — video tidak tersedia di wilayah server", 8);
  if (lower.includes("copyright"))
    return make("Region Blocked — video diblokir karena klaim copyright", 8);

  // ── HTTP 404 / not found — priority 2 (very low: might be client rejection, not real 404)
  if (lower.includes("not found") || lower.includes("no such video") || lower.includes("http error 404"))
    return make("Video tidak dapat ditemukan — pastikan link valid dan video masih tersedia", 2);

  // ── Generic — priority 1 (lowest)
  return make(`Download gagal: ${raw.slice(0, 200)}`, 1);
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
    // Only include failures that NO alternate provider can recover.
    // The video itself must be inaccessible regardless of HOW it is downloaded.
    //
    // "tidak tersedia" (video unavailable) is EXCLUDED: YouTube returns this for
    // PO-token client rejections — a CLIENT auth failure, not a deleted video.
    //
    // "tidak ditemukan" / HTTP 404 is EXCLUDED: YouTube returns HTTP 404 for
    // some API endpoints when a player-client isn't authorised — that's a client
    // rejection, not a real missing video. Let all fallback providers try first.
    m.includes("dihapus")          ||  // truly deleted video
    m.includes("privat")           ||  // private — no provider can access it
    m.includes("live stream")      ||  // live streams can't be extracted as audio
    m.includes("siaran langsung")  ||  // same, in translated form
    m.includes("drm protected")    ||  // DRM — no provider can decrypt it
    m.includes("dibatasi usia")    ||  // age-restricted + login required
    m.includes("region blocked")      // truly geo-blocked
    // "usia" / "login" / "tidak tersedia" / "tidak ditemukan" intentionally removed.
    // "timed out" / "network timeout" intentionally excluded.
  );
}

/**
 * Return the higher-priority of two errors.
 * Errors from _translateError carry a numeric `.priority` (1–9, higher = more
 * informative). Falls back to comparing message length if no priority set.
 * @private
 */
function _betterError(a, b) {
  const pa = a?.priority ?? 0;
  const pb = b?.priority ?? 0;
  return pa >= pb ? a : b;
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

  // ── Method 3: web_creator client — a newer YouTube client that often
  // bypasses PO-token requirements that block android_vr in 2026.
  // Returns full audio-only formats (same as default) when android_vr fails.
  [
    "--extractor-args", "youtube:player_client=web_creator",
  ],

  // ── Method 4: android client — verified working fallback, lower quality
  // (single muxed itag 18, ~44kbps) but real audio, not a guaranteed fail.
  [
    "--extractor-args", "youtube:player_client=android",
    "--add-headers", "User-Agent:com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
  ],

  // ── Method 5: web_embedded client — simpler client fingerprint,
  // sometimes accepted by YouTube when other clients are PO-gated.
  [
    "--extractor-args", "youtube:player_client=web_embedded",
  ],
];

/** Per-method timeout — dipercepat agar fallback loop tidak memblok terlalu lama.
 * Methods 1–4: 30s each (fail fast if blocked; most real downloads finish < 20s).
 * Last method:  90s (full budget for slow connections / large files). */
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

  // ytdl-core always downloads as .m4a (opus/aac audio track from YouTube).
  // We need to produce the format the caller requested (mp3 or m4a).
  //
  // Skip ffmpeg entirely when the downloaded format already matches the
  // target: m4a→m4a (type === "mp4") is a straight rename with no quality
  // loss and no external tool needed. mp3 requests still need ffmpeg to
  // re-encode, but ffmpeg-static guarantees it is always available.
  const audioFmt  = type === "mp4" ? "m4a" : "mp3";
  const audioQ    = type === "mp3" ? `${quality}k` : undefined;
  const finalFile = path.join(tmpDir, `audio_final.${audioFmt}`);

  // "ext" is "m4a" — the format ytdl-core downloads
  if (audioFmt === "m4a") {
    // Already m4a — just rename, no conversion needed.
    fs.renameSync(outputFile, finalFile);
    logger.info(`[ytmp3gg] ytdl-core — skipping ffmpeg (already m4a)`);
  } else {
    // Convert m4a → mp3 using ffmpeg (always available via ffmpeg-static).
    logger.info(`[ytmp3gg] ytdl-core — transcoding m4a → mp3 with ffmpeg`);
    const ffmpegArgs = ["-y", "-i", outputFile, "-vn", "-b:a", audioQ, finalFile];
    await execFileAsync(FFMPEG_PATH, ffmpegArgs, { timeout: 60_000, signal });
    try { fs.unlinkSync(outputFile); } catch {}
  }

  const details  = info.videoDetails ?? {};
  const title     = details.title || null;
  const duration  = details.lengthSeconds ? parseInt(details.lengthSeconds, 10) : null;
  const uploader  = details.author?.name || null;
  const thumbnail = details.thumbnails?.at(-1)?.url || null;

  const sizeKB = (fs.statSync(finalFile).size / 1024).toFixed(1);
  logger.info(`[ytmp3gg] ✅ Fallback engine succeeded | title="${title}" (${sizeKB} KB)`);

  return { title, thumbnail, uploader, duration, type, quality: String(quality), localFile: finalFile, tmpDir, provider: "ytdl-core" };
}

// ── Parallel provider race ─────────────────────────────────────────────────────
//
// Runs yt-dlp (default method, 30 s) and ytdl-core simultaneously.
// The first provider to produce a valid audio file wins — the other is
// cancelled via AbortController and its tmpDir is cleaned up.
//
// Health stats are NOT recorded here — only in the sequential fallback loop,
// so a race failure does not prematurely count against either provider's
// circuit-breaker.
//
// Returns { winner: string, result: object } on success.
// Throws AggregateError (with .errors array) when both fail.
//
async function _runParallelRace(input, type, quality, signal) {
  const raceTmpA = fs.mkdtempSync(path.join(os.tmpdir(), "bb-race-ytdlp-"));
  const raceTmpB = fs.mkdtempSync(path.join(os.tmpdir(), "bb-race-ytdlc-"));

  const ctrlA = new AbortController();
  const ctrlB = new AbortController();

  // Propagate parent abort to both children
  const onParentAbort = () => { ctrlA.abort(); ctrlB.abort(); };
  if (signal) signal.addEventListener("abort", onParentAbort, { once: true });

  const cleanupA = () => { try { fs.rmSync(raceTmpA, { recursive: true, force: true }); } catch {} };
  const cleanupB = () => { try { fs.rmSync(raceTmpB, { recursive: true, force: true }); } catch {} };

  const pA = _attempt(input, type, quality, YOUTUBE_METHODS[0], raceTmpA, 30_000, ctrlA.signal)
    .then((stdout) => {
      ctrlB.abort();
      const result = _parseOutput(stdout, raceTmpA, type, quality, "yt-dlp (race)");
      setTimeout(cleanupB, 500); // let ytdl-core settle before cleanup
      return { winner: "yt-dlp", result };
    });

  const pB = _ytdlCoreFallback(input, type, quality, raceTmpB, null, ctrlB.signal)
    .then((result) => {
      ctrlA.abort();
      result = { ...result, provider: "ytdl-core (race)" };
      setTimeout(cleanupA, 500);
      return { winner: "ytdl-core", result };
    });

  try {
    return await Promise.any([pA, pB]);
  } catch (aggErr) {
    // Both failed — clean up both tmpDirs
    cleanupA(); cleanupB();
    throw aggErr;
  } finally {
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }
}

async function _ytdlYouTube(input, type, quality, onProgress, signal) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-"));

  // bestError tracks the MOST INFORMATIVE error seen so far across all providers.
  // Each translated error carries a `.priority` (1–9); we keep the highest.
  // This ensures the final user-facing message reflects the real root cause
  // (e.g. "Anti-Bot Detection") rather than whichever generic error happened last.
  let bestError = Object.assign(
    new Error("YouTube download gagal setelah semua metode dicoba"), { priority: 0 }
  );

  // providerNum is a sequential counter for structured [Provider N] log lines.
  let providerNum = 0;

  // ── ⚡ Parallel race — yt-dlp default vs ytdl-core (fast path) ──────────────
  // Both providers start simultaneously with a 30s window.
  // Winner returns immediately; the other is cancelled and cleaned up.
  // On failure, the sequential fallback chain below handles recovery.
  // Health tracking is deliberately skipped here to avoid false OFFLINE marks.
  if (!providerHealth.shouldSkip("yt-dlp-youtube") && !providerHealth.shouldSkip("ytdl-core") && !signal?.aborted) {
    logger.info(`[ytmp3gg] ⚡ Parallel race: yt-dlp vs ytdl-core`);
    try {
      const { winner, result } = await _runParallelRace(input, type, quality, signal);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      logger.info(`[ytmp3gg] ⚡ Race winner: ${winner} | provider=${result.provider}`);
      if (winner === "yt-dlp")    providerHealth.recordSuccess("yt-dlp-youtube");
      if (winner === "ytdl-core") providerHealth.recordSuccess("ytdl-core");
      return result;
    } catch (aggErr) {
      // Both failed — record best error from either, then fall through
      if (_isAborted(aggErr?.errors?.[0] ?? aggErr, signal)) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        const ae = new Error("Dibatalkan (timeout tahap)"); ae.name = "AbortError"; throw ae;
      }
      const raceErrors = aggErr.errors ?? [aggErr];
      for (const e of raceErrors) bestError = _betterError(bestError, _translateError(e));
      logger.warn(`[ytmp3gg] ⚡ Race failed — falling back to sequential chain`);
    }
  }

  // ── Provider 1: yt-dlp multi-method ──────────────────────────────────────
  providerNum++;
  if (providerHealth.shouldSkip("yt-dlp-youtube")) {
    logger.warn(`[ytmp3gg] [Provider ${providerNum}] yt-dlp (YouTube) | Status: OFFLINE | Reason: 5x consecutive failure — switch to backup providers`);
    bestError = _betterError(bestError,
      Object.assign(new Error("yt-dlp OFFLINE — mencoba provider cadangan"), { priority: 2 }));
  } else {
    let ytdlpFailed = false;
    for (let i = 0; i < YOUTUBE_METHODS.length; i++) {
      if (signal?.aborted) {
        const ae = new Error("Dibatalkan (timeout tahap)"); ae.name = "AbortError";
        bestError = ae;
        ytdlpFailed = true;
        break;
      }
      if (i > 0) {
        try { for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f)); } catch {}
        await onProgress?.("Trying another method...");
      }

      logger.info(`[ytmp3gg] [Provider ${providerNum}] yt-dlp (YouTube) method ${i + 1}/${YOUTUBE_METHODS.length} | Status: Trying`);
      try {
        const stdout = await _attempt(input, type, quality, YOUTUBE_METHODS[i], tmpDir, _methodTimeout(i), signal);
        logger.info(`[ytmp3gg] [Provider ${providerNum}] yt-dlp (YouTube) method ${i + 1}/${YOUTUBE_METHODS.length} | Status: SUCCESS`);
        providerHealth.recordSuccess("yt-dlp-youtube");
        return _parseOutput(stdout, tmpDir, type, quality, `yt-dlp/method${i + 1}`);
      } catch (err) {
        if (_isAborted(err, signal)) { bestError = err; ytdlpFailed = true; break; }
        const translated = _translateError(err);
        logger.warn(`[ytmp3gg] [Provider ${providerNum}] yt-dlp (YouTube) method ${i + 1}/${YOUTUBE_METHODS.length} | Status: FAILED | Reason: ${translated.message}`);
        bestError = _betterError(bestError, translated);

        // Only stop the yt-dlp loop for truly unrecoverable per-video issues.
        // 404 / "video unavailable" are NOT permanent here — they may be client-
        // rejection responses that the next player-client or fallback provider handles.
        if (_isPermanentFailure(translated)) {
          logger.info(`[ytmp3gg] [Provider ${providerNum}] Stopping yt-dlp loop — permanent failure: ${translated.message}`);
          ytdlpFailed = true;
          break;
        }
        if (i < YOUTUBE_METHODS.length - 1) {
          logger.info(`[ytmp3gg] [Provider ${providerNum}] Switch → yt-dlp method ${i + 2}/${YOUTUBE_METHODS.length}`);
        }
      }
    }

    // Don't count truly deleted/private videos against yt-dlp health.
    if (!_isAborted(bestError, signal) && !_isPermanentFailure(bestError)) {
      providerHealth.recordFailure("yt-dlp-youtube", {
        reason:    bestError.message,
        isTimeout: bestError.message.toLowerCase().includes("timeout"),
      });
    }
  }

  if (_isAborted(bestError, signal)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw bestError;
  }

  // If the best error so far is truly permanent (deleted/private/live/DRM),
  // no alternate provider will help — skip the entire backup chain.
  if (_isPermanentFailure(bestError)) {
    logger.info(`[ytmp3gg] Permanent failure confirmed — skipping all backup providers | Reason: ${bestError.message}`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw bestError;
  }

  try { for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f)); } catch {}

  // ── Provider 2: @distube/ytdl-core ───────────────────────────────────────
  providerNum++;
  if (providerHealth.shouldSkip("ytdl-core")) {
    logger.warn(`[ytmp3gg] [Provider ${providerNum}] ytdl-core | Status: OFFLINE | Reason: 5x consecutive failure — switch to next`);
  } else if (!signal?.aborted) {
    logger.info(`[ytmp3gg] [Provider ${providerNum}] ytdl-core | Status: Trying`);
    try {
      const result = await _ytdlCoreFallback(input, type, quality, tmpDir, onProgress, signal);
      providerHealth.recordSuccess("ytdl-core");
      logger.info(`[ytmp3gg] [Provider ${providerNum}] ytdl-core | Status: SUCCESS`);
      return { ...result, provider: "ytdl-core" };
    } catch (err) {
      if (_isAborted(err, signal)) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} throw err; }
      logger.warn(`[ytmp3gg] [Provider ${providerNum}] ytdl-core | Status: FAILED | Reason: ${err.message}`);
      bestError = _betterError(bestError, Object.assign(err, { priority: err.priority ?? 2 }));
      providerHealth.recordFailure("ytdl-core", { reason: err.message, isTimeout: err.message.toLowerCase().includes("timeout") });
    }
  }

  // ── Provider 3: Kaizen API ────────────────────────────────────────────────
  providerNum++;
  try { for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f)); } catch {}

  if (providerHealth.shouldSkip("kaizenapi")) {
    logger.warn(`[ytmp3gg] [Provider ${providerNum}] Kaizen API | Status: OFFLINE | Reason: 5x consecutive failure — switch to next`);
  } else if (!signal?.aborted) {
    await onProgress?.("Trying alternative API...");
    logger.info(`[ytmp3gg] [Provider ${providerNum}] Kaizen API | Status: Trying | Endpoint: kaizenapi.my.id/downloader/youtube`);
    try {
      const result = await kaizenDownload(input, type, quality, tmpDir, signal);
      providerHealth.recordSuccess("kaizenapi");
      logger.info(`[ytmp3gg] [Provider ${providerNum}] Kaizen API | Status: SUCCESS`);
      return { ...result, provider: "kaizen" };
    } catch (kaizenErr) {
      if (_isAborted(kaizenErr, signal)) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} throw kaizenErr; }
      logger.warn(`[ytmp3gg] [Provider ${providerNum}] Kaizen API | Status: FAILED | Reason: ${kaizenErr.message}`);
      bestError = _betterError(bestError, Object.assign(kaizenErr, { priority: kaizenErr.priority ?? 2 }));
      providerHealth.recordFailure("kaizenapi", { reason: kaizenErr.message, isTimeout: kaizenErr.message.toLowerCase().includes("timeout") });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Provider 4: Piped (public YouTube frontend) ───────────────────────────
  providerNum++;
  if (!signal?.aborted) {
    const pipedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-piped-"));
    await onProgress?.("Trying Piped API...");
    logger.info(`[ytmp3gg] [Provider ${providerNum}] Piped | Status: Trying`);
    try {
      const result = await _pipedFallback(input, type, quality, pipedTmpDir, onProgress, signal);
      logger.info(`[ytmp3gg] [Provider ${providerNum}] Piped | Status: SUCCESS`);
      return { ...result, provider: "piped" };
    } catch (pipedErr) {
      if (_isAborted(pipedErr, signal)) { try { fs.rmSync(pipedTmpDir, { recursive: true, force: true }); } catch {} const ae = new Error("Dibatalkan (timeout tahap)"); ae.name = "AbortError"; throw ae; }
      logger.warn(`[ytmp3gg] [Provider ${providerNum}] Piped | Status: FAILED | Reason: ${pipedErr.message}`);
      bestError = _betterError(bestError, Object.assign(pipedErr, { priority: pipedErr.priority ?? 2 }));
      try { fs.rmSync(pipedTmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Provider 5: Invidious (public YouTube alternative API) ────────────────
  providerNum++;
  if (!signal?.aborted) {
    const invTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-inv-"));
    await onProgress?.("Trying Invidious API...");
    logger.info(`[ytmp3gg] [Provider ${providerNum}] Invidious | Status: Trying`);
    try {
      const result = await _invidiousFallback(input, type, quality, invTmpDir, onProgress, signal);
      logger.info(`[ytmp3gg] [Provider ${providerNum}] Invidious | Status: SUCCESS`);
      return { ...result, provider: "invidious" };
    } catch (invErr) {
      if (_isAborted(invErr, signal)) { try { fs.rmSync(invTmpDir, { recursive: true, force: true }); } catch {} const ae = new Error("Dibatalkan (timeout tahap)"); ae.name = "AbortError"; throw ae; }
      logger.warn(`[ytmp3gg] [Provider ${providerNum}] Invidious | Status: FAILED | Reason: ${invErr.message}`);
      bestError = _betterError(bestError, Object.assign(invErr, { priority: invErr.priority ?? 2 }));
      try { fs.rmSync(invTmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  // ── All providers exhausted — throw the most informative error ────────────
  logger.error(`[ytmp3gg] Final Reason: ${bestError.message}`);
  throw bestError;
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
  // ── Method 1: Trill app extractor — paling andal untuk TikTok CDN modern (2024+).
  // TikTok internal API "Trill" menggunakan endpoint CDN berbeda yang lebih sedikit
  // diblokir dibanding web extractor default. Ini fix utama untuk HTTP 403.
  [
    "--extractor-args", "tiktok:app_name=trill",
    "--no-check-certificates",
  ],

  // ── Method 2: Trill + Chrome desktop UA + TikTok Referer
  [
    "--extractor-args", "tiktok:app_name=trill",
    "--no-check-certificates",
    "--add-headers", "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "--add-headers", "Referer:https://www.tiktok.com/",
  ],

  // ── Method 3: TikTok Lite app — fingerprint berbeda, rate limit lebih rendah
  [
    "--extractor-args", "tiktok:app_name=lite",
    "--no-check-certificates",
    "--add-headers", "User-Agent:Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
    "--add-headers", "Referer:https://www.tiktok.com/",
  ],

  // ── Method 4: Trill + bestaudio format + mobile UA
  [
    "--extractor-args", "tiktok:app_name=trill",
    "--no-check-certificates",
    "--format", "bestaudio[ext=m4a]/bestaudio/best",
    "--add-headers", "User-Agent:Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
    "--add-headers", "Referer:https://www.tiktok.com/",
  ],

  // ── Method 5: Standard (no special flags) — fallback ke plain yt-dlp default
  [],

  // ── Method 6: Skip cert check + Chrome desktop UA + TikTok Referer (non-Trill)
  [
    "--no-check-certificates",
    "--add-headers", "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "--add-headers", "Referer:https://www.tiktok.com/",
  ],

  // ── Method 7: Extended retries + TikTok iOS UA
  [
    "--no-check-certificates",
    "--extractor-retries", "5",
    "--fragment-retries", "5",
    "--retry-sleep", "exponential=1:2",
    "--add-headers", "User-Agent:TikTok/26.2.3 (iPhone; iOS 16.6; Scale/3.00)",
    "--add-headers", "Referer:https://www.tiktok.com/",
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
    ? [
        // Method 1: Trill extractor — paling andal untuk TikTok modern (fix HTTP 403)
        [
          "--extractor-args", "tiktok:app_name=trill",
          "--no-check-certificates",
        ],
        // Method 2: Trill + Chrome UA
        [
          "--extractor-args", "tiktok:app_name=trill",
          "--no-check-certificates",
          "--add-headers", "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "--add-headers", "Referer:https://www.tiktok.com/",
        ],
        // Method 3: Standard Chrome UA (metode lama sebagai fallback)
        [
          "--no-check-certificates",
          "--add-headers", "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "--add-headers", "Referer:https://www.tiktok.com/",
        ],
      ]
    : [
        [],                                                                        // Method 1: yt-dlp default (android_vr internally)
        ["--extractor-args", "youtube:player_client=android_vr"],                 // Method 2: android_vr pinned
        ["--extractor-args", "youtube:player_client=web_creator"],                // Method 3: web_creator — bypasses PO-token gate
        ["--extractor-args", "youtube:player_client=android",
         "--add-headers", "User-Agent:com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip"],  // Method 4: android
        // NOTE: player_client=tv is intentionally excluded — it hits YouTube's
        // SABR-only gate and never returns playable formats without a JS runtime
        // that can solve the full SABR challenge.  See YOUTUBE_METHODS comment.
      ];

  // Increased from 8s → 20s: Railway has higher latency than a local machine,
  // and yt-dlp --simulate on YouTube can take 5-10s on first call.
  const INFO_TIMEOUT_MS = 20_000;

  for (let i = 0; i < infoMethods.length; i++) {
    const args = [
      "--no-playlist",
      "--simulate",
      "--no-warnings",
      "--extractor-retries", "1",
      "--print", "%(duration)s|||%(title)s|||%(thumbnail)s|||%(uploader)s",
      ...COOKIES_ARGS,    // cookies for anti-bot bypass ([] when not configured)
      ...infoMethods[i],
      resolvedUrl,
    ];

    try {
      const { stdout } = await execFileAsync(BIN_PATH, args, {
        timeout:   INFO_TIMEOUT_MS,
        maxBuffer: 1 * 1024 * 1024,
      });
      const line            = stdout.trim().split("\n").find(l => l.includes("|||")) ?? "";
      const [rawDur, rawTitle, rawThumb, rawUp] = line.split("|||");
      const duration = rawDur && !isNaN(rawDur) ? parseInt(rawDur, 10) : null;
      const title    = rawTitle?.trim() || null;
      if (title || duration) {
        // Got at least some metadata — good enough to proceed.
        logger.info(`[ytmp3gg] getVideoInfo OK (method ${i + 1}) | title="${title}" duration=${duration}s`);
        return {
          duration,
          title,
          thumbnail: rawThumb?.trim() || null,
          uploader:  rawUp?.trim()    || null,
        };
      }
      // stdout parsed but both title and duration are empty — try next method.
      logger.warn(`[ytmp3gg] getVideoInfo method ${i + 1}: yt-dlp ran but returned no metadata (title=null, duration=null) — trying next`);
    } catch (err) {
      logger.warn(`[ytmp3gg] getVideoInfo method ${i + 1}/${infoMethods.length} failed: ${err.message}`);
    }
  }

  // ── yt-dlp metadata fallback: ytdl-core ────────────────────────────────────
  // All yt-dlp simulate attempts failed. Try @distube/ytdl-core as a metadata-
  // only fallback before giving up — it uses a completely different extraction
  // path and succeeds in many cases where yt-dlp's player-client is blocked.
  if (!isTikTok) {
    try {
      logger.info(`[ytmp3gg] getVideoInfo: all yt-dlp methods failed — falling back to ytdl-core for metadata`);
      const info = await _withTimeout(
        ytdlCore.getInfo(resolvedUrl, {
          requestOptions: {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
          },
        }),
        YTDL_CORE_INFO_TIMEOUT_MS,
        `ytdl-core getInfo for metadata timed out (>${YTDL_CORE_INFO_TIMEOUT_MS / 1000}s)`,
      );
      const details  = info.videoDetails ?? {};
      const duration = details.lengthSeconds ? parseInt(details.lengthSeconds, 10) : null;
      const title    = details.title || null;
      if (title || duration) {
        logger.info(`[ytmp3gg] getVideoInfo ytdl-core fallback OK | title="${title}" duration=${duration}s`);
        return {
          duration,
          title,
          thumbnail: details.thumbnails?.at(-1)?.url || null,
          uploader:  details.author?.name           || null,
        };
      }
    } catch (coreErr) {
      logger.warn(`[ytmp3gg] getVideoInfo ytdl-core fallback failed: ${coreErr.message}`);
    }
  }

  // All methods failed — non-fatal, caller treats null duration as "unknown,
  // proceed anyway" and the real ytdl() download call still gets its own
  // full multi-method fallback.
  return { duration: null, title: null, thumbnail: null, uploader: null };
}
