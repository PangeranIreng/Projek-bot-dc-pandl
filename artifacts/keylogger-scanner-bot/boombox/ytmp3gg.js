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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR   = path.join(__dirname, "..", "bin");
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

// ── Binary bootstrap ──────────────────────────────────────────────────────────

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
      https.get(url, (res) => {
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
      }).on("error", (e) => {
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

/**
 * Ensure the yt-dlp_linux binary exists AND is up to date.
 * On every bot start: download if missing, then check GitHub for a newer
 * release and auto-update if one is found. Version check failure is
 * non-fatal — the existing binary is used as-is.
 */
async function ensureBinary() {
  if (!fs.existsSync(BIN_PATH)) {
    await _downloadBinary();
    return;
  }

  // Read the local version
  let localVersion = null;
  try {
    const { stdout } = await execFileAsync(BIN_PATH, ["--version"], { timeout: 10_000 });
    localVersion = stdout.trim();
  } catch {
    logger.warn("[ytmp3gg] Could not read yt-dlp version — re-downloading");
    await _downloadBinary();
    return;
  }

  // Compare with the latest GitHub release
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

// ── Core download logic ───────────────────────────────────────────────────────

/**
 * One download attempt with a specific set of extra args.
 * @private
 */
async function _attempt(input, type, quality, extraArgs, tmpDir, timeoutMs = 120_000) {
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
  });

  if (stderr?.trim()) logger.debug(`[ytmp3gg] stderr: ${stderr.trim()}`);
  return stdout;
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

/** Returns true for errors where retrying with different args won't help. */
function _isPermanentFailure(err) {
  const m = err.message.toLowerCase();
  return (
    m.includes("tidak tersedia")   ||
    m.includes("dihapus")          ||
    m.includes("privat")           ||
    m.includes("usia")             ||
    m.includes("login")            ||
    m.includes("region blocked")   ||
    m.includes("timed out")        ||
    m.includes("tidak ditemukan")
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

const TIKTOK_UA_SETS = [
  {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Referer: "https://www.tiktok.com/",
  },
  {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
    Referer: "https://www.tiktok.com/",
  },
];

function _isTikTokBouncePage(url) {
  try {
    const { pathname } = new URL(url);
    return pathname === "" || pathname === "/" || /^\/(in\/about|about|login)/i.test(pathname);
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
 * Resolve a TikTok short/share link to its canonical video URL by following
 * redirects with browser-like headers. Falls back to the original URL
 * (letting yt-dlp's own fallback methods try it directly) if resolution
 * never lands on a real video page.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function resolveTikTokUrl(url) {
  if (!/tiktok\.com/i.test(url)) return url;

  for (let i = 0; i < TIKTOK_UA_SETS.length; i++) {
    try {
      const resolved = await _followRedirects(url, TIKTOK_UA_SETS[i]);
      if (!_isTikTokBouncePage(resolved)) {
        if (resolved !== url) logger.info(`[ytmp3gg] TikTok short URL resolved: ${url} -> ${resolved}`);
        return resolved;
      }
      logger.warn(`[ytmp3gg] TikTok resolve attempt ${i + 1} bounced to ${resolved} — retrying with different headers`);
    } catch (err) {
      logger.warn(`[ytmp3gg] TikTok resolve attempt ${i + 1} failed: ${err.message}`);
    }
  }

  logger.warn(`[ytmp3gg] Could not resolve TikTok URL to a canonical video page — passing original to yt-dlp`);
  return url;
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

/** Per-method timeout — early methods fail fast so the retry loop doesn't
 * burn minutes before reaching the client that actually works; the last
 * one gets the full budget in case it just needs more time. */
function _methodTimeout(i) {
  return i < YOUTUBE_METHODS.length - 1 ? 45_000 : 120_000;
}

/**
 * Last-resort YouTube fallback using @distube/ytdl-core — a completely
 * separate implementation (its own signature/PO-token handling, its own
 * HTTP client) from yt-dlp. It fails for different reasons than yt-dlp, so
 * it recovers a real fraction of cases where every yt-dlp player-client
 * variant above was bot-gated or hit a signature-extraction regression.
 * @private
 */
async function _ytdlCoreFallback(input, type, quality, tmpDir, onProgress) {
  logger.info(`[ytmp3gg] YouTube — trying fallback engine (@distube/ytdl-core)`);
  await onProgress?.("Recovering download...");

  const info = await ytdlCore.getInfo(input, {
    requestOptions: {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
    },
  });

  const ext        = "m4a";
  const outputFile = path.join(tmpDir, `audio.${ext}`);
  const stream      = ytdlCore.downloadFromInfo(info, { quality: "highestaudio", filter: "audioonly" });

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputFile);
    stream.on("error", reject);
    file.on("error", reject);
    file.on("finish", resolve);
    stream.pipe(file);
  });

  // Transcode to the requested output format/quality with ffmpeg, matching
  // what the yt-dlp path produces, so downstream code (top4top upload,
  // embeds) sees a consistent file type either way.
  const audioFmt   = type === "mp4" ? "m4a" : "mp3";
  const audioQ     = type === "mp3" ? `${quality}k` : undefined;
  const finalFile  = path.join(tmpDir, `audio_final.${audioFmt}`);
  const ffmpegArgs = ["-y", "-i", outputFile, "-vn"];
  if (audioQ) ffmpegArgs.push("-b:a", audioQ);
  ffmpegArgs.push(finalFile);

  await execFileAsync(FFMPEG_PATH, ffmpegArgs, { timeout: 60_000 });
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

async function _ytdlYouTube(input, type, quality, onProgress) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-"));
  let   lastError = new Error("YouTube download gagal setelah semua metode dicoba");

  for (let i = 0; i < YOUTUBE_METHODS.length; i++) {
    if (i > 0) {
      try {
        for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      } catch {}
      await onProgress?.("Trying another method...");
    }

    logger.info(`[ytmp3gg] YouTube — trying method ${i + 1}/${YOUTUBE_METHODS.length}`);
    try {
      const stdout = await _attempt(input, type, quality, YOUTUBE_METHODS[i], tmpDir, _methodTimeout(i));
      logger.info(`[ytmp3gg] YouTube method ${i + 1} succeeded — stopping fallback loop`);
      return _parseOutput(stdout, tmpDir, type, quality);
    } catch (err) {
      lastError = _translateError(err);
      logger.warn(`[ytmp3gg] YouTube method ${i + 1} failed: ${lastError.message}`);

      if (_isPermanentFailure(lastError)) {
        logger.info(`[ytmp3gg] Permanent failure — stopping YouTube fallback`);
        break;
      }
    }
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

  // ── API 2: @distube/ytdl-core ─────────────────────────────────────────────
  try {
    return await _ytdlCoreFallback(input, type, quality, tmpDir, onProgress);
  } catch (err) {
    logger.warn(`[ytmp3gg] API 2 (ytdl-core) also failed: ${err.message}`);
    // ytdl-core failed too — fall through to API 3 (kaizenapi)
  }

  // ── API 3 (last resort): kaizenapi.my.id ─────────────────────────────────
  // Only used when BOTH yt-dlp and ytdl-core have been exhausted.
  // Never used as primary or secondary — only as final backup.
  try {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
  } catch {}

  try {
    await onProgress?.("Trying alternative API...");
    logger.info(`[ytmp3gg] YouTube — trying API 3 (kaizenapi.my.id)`);
    return await kaizenDownload(input, type, quality, tmpDir);
  } catch (kaizenErr) {
    logger.warn(`[ytmp3gg] API 3 (kaizenapi) also failed: ${kaizenErr.message}`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw lastError;
  }
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

async function _ytdlTikTok(input, type, quality, onProgress) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-"));
  let   lastError = new Error("TikTok download gagal setelah semua metode dicoba");

  for (let i = 0; i < TIKTOK_METHODS.length; i++) {
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
      const stdout = await _attempt(input, type, quality, TIKTOK_METHODS[i], tmpDir);
      return _parseOutput(stdout, tmpDir, type, quality);
    } catch (err) {
      lastError = _translateError(err);
      logger.warn(`[ytmp3gg] TikTok method ${i + 1} failed: ${lastError.message}`);

      if (_isPermanentFailure(lastError)) {
        logger.info(`[ytmp3gg] Permanent failure — stopping TikTok fallback`);
        break;
      }
    }
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
 * @returns {Promise<{ title, thumbnail, uploader, duration, type, quality, localFile, tmpDir }>}
 */
export async function ytdl(input, type = "mp3", quality = "128", onProgress = null) {
  await ensureBinary();

  const isTikTok = /tiktok\.com/i.test(input);
  const resolvedInput = isTikTok ? await resolveTikTokUrl(input) : input;

  logger.info(`[ytmp3gg] ▶ Starting download | url="${resolvedInput}" type=${type} quality=${quality}`);

  if (isTikTok) {
    return _ytdlTikTok(resolvedInput, type, quality, onProgress);
  }

  return _ytdlYouTube(resolvedInput, type, quality, onProgress);
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
  await ensureBinary();

  const isTikTok = /tiktok\.com/i.test(url);
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
        timeout:   20_000,
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
