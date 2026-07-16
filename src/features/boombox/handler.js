/**
 * boomboxHandler.js — Main BoomBox message handler.
 *
 * Pipeline:
 *   [1]  Request received — validate channel / role / URL / daily limit
 *   [2]  getVideoInfo()  — fast metadata fetch, duration check
 *   [3]  Send processing embed (Preparing...)
 *   [4]  Edit embed → Downloading Audio...
 *   [5]  ytdl() — download audio to /tmp
 *   [6]  Edit embed → Uploading to Top4Top...
 *   [7]  top4top() — upload file
 *   [8]  Edit embed → Generating BoomBox URL... → Finished.
 *   [9]  Edit embed → result embed + buttons
 *   [10] Append entry to BoomBox Logs message (create if needed)
 *   [11] Temp file cleanup in finally block
 *
 * All caught errors are forwarded to the global error logger.
 */

import fs from "node:fs";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

import { BOOMBOX_CONFIG, ALLOWED_ROLES, UNLIMITED_ROLES } from "./config.js";
import { ytdl, getVideoInfo }  from "../../services/ytmp3gg.js";
import { top4top }             from "../../services/top4top.js";
import { db, premDB }          from "../../database/db.js";
import * as boomboxCache       from "../../services/boomboxCache.js";
import { extractVideoId }      from "../../services/boomboxCache.js";
import { resolveSpotify, isSpotifyUrl } from "../../services/spotifyResolver.js";
import {
  buildProcessingEmbed,
  buildResultEmbed,
  buildDurationLimitEmbed,
  buildErrorEmbed,
  buildUserErrorEmbed,
  buildUnsupportedPlatformEmbed,
  buildQueueEmbed,
} from "./embed.js";
import { storeErrorDetail } from "./errorStore.js";
import { updateBoomBoxLogDashboard } from "../logs/logDashboard.js";
import { enqueueBoomBoxJob } from "../queue/boomboxQueue.js";
import { logError } from "../../utils/errorLogger.js";
import { logger }   from "../../utils/logger.js";

// ── Singletons ────────────────────────────────────────────────────────────────
// `db`/`premDB` come from the shared db.js module (not `new BoomBoxDB()` here)
// so slash commands (/addprem, /setlimit, ...) and this handler always read
// and write the same in-memory cache instead of two divergent copies.

/** Rolling dedup — prevents double-processing on gateway reconnects. */
const processingSet = new Set();
const MAX_DEDUP     = 200;

/** Maximum video duration allowed (seconds). */
const MAX_DURATION_SEC = 25 * 60; // 25 minutes

// ── Result cache ──────────────────────────────────────────────────────────────
// Moved to src/services/boomboxCache.js:
//   • VideoID-keyed (not URL-keyed) — same video via different URL formats hits cache
//   • Tracks hitCount, lastUsed, expire per entry
//   • Auto-clean timer: evicts entries unused for > 90 days
//   • Metadata cache: caches title/duration/thumbnail/uploader for 24h
// Import: `boomboxCache.*` and `extractVideoId` above.

// ── URL helpers ───────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>"]+/gi;

const PLATFORM_PATTERNS = [
  {
    name:  "YouTube",
    regex: /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts|live)|youtu\.be\/|music\.youtube\.com\/watch)/i,
  },
  {
    name:  "TikTok",
    // Covers any tiktok.com subdomain: tiktok.com, www., m., vt., vm., music., etc.
    regex: /^https?:\/\/([a-z0-9-]+\.)?tiktok\.com\//i,
  },
  {
    name:  "Spotify",
    // Spotify track links only — albums and playlists are not downloadable as a single file.
    regex: /^https?:\/\/open\.spotify\.com\/track\//i,
  },
];

function extractUrls(text) {
  return [...(text.match(URL_RE) ?? [])];
}

function detectPlatform(url) {
  for (const p of PLATFORM_PATTERNS) {
    if (p.regex.test(url)) return p.name;
  }
  return null;
}

// ── Role / Premium helpers ────────────────────────────────────────────────────
// Combines the static role lists (boomboxConfig.js) with premiumDB (virtual,
// bot-tracked grants from /addprem, /setlimit — survives restarts and doesn't
// require an actual Discord role).

function isStaticUnlimited(member) {
  return member.roles.cache.some(r => UNLIMITED_ROLES.includes(r.id));
}

function isPremiumMember(member) {
  if (isStaticUnlimited(member)) return true;
  if (premDB.isUserPremium(member.id)) return true;
  return member.roles.cache.some(r => premDB.isRolePremium(r.id));
}

function hasCustomLimitOverride(member) {
  if (premDB.getCustomLimitUser(member.id)) return true;
  return member.roles.cache.some(r => premDB.getCustomLimitRole(r.id));
}

function hasAllowedRole(member) {
  if (member.roles.cache.some(r => ALLOWED_ROLES.includes(r.id))) return true;
  if (isPremiumMember(member)) return true;
  return hasCustomLimitOverride(member);
}

function isUnlimited(member) {
  return isPremiumMember(member);
}

/** Highest applicable daily limit for a non-unlimited member: personal
 * override > best role override > global default. */
function effectiveDailyLimit(member) {
  const userOverride = premDB.getCustomLimitUser(member.id);
  if (userOverride) return userOverride.limit;

  let max = null;
  for (const r of member.roles.cache.values()) {
    const roleOverride = premDB.getCustomLimitRole(r.id);
    if (roleOverride && (max === null || roleOverride.limit > max)) max = roleOverride.limit;
  }
  if (max !== null) return max;

  return db.getFreeDailyLimit();
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

// smoothDelay() dihapus — animasi tambahan tidak diperlukan.

/**
 * Bounds a stage so it can never hang the job/queue slot forever.
 *
 * Accepts EITHER:
 *   • A plain Promise  — `withStageTimeout(somePromise, ms, label)`
 *   • A factory fn     — `withStageTimeout((signal) => makePromise(signal), ms, label)`
 *
 * When a factory is provided an AbortController is created and its signal is
 * passed into the factory. When the timeout fires, `controller.abort()` is
 * called BEFORE rejecting, so yt-dlp child processes receive a SIGTERM and
 * terminate immediately instead of running as zombies until the 10-min queue
 * ceiling catches them (FIX Bug 4: zombie yt-dlp processes on stage timeout).
 */
function withStageTimeout(promiseOrFactory, ms, stageLabel) {
  const isFactory = typeof promiseOrFactory === "function";
  const controller = isFactory ? new AbortController() : null;
  const work = isFactory ? promiseOrFactory(controller.signal) : promiseOrFactory;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort(); // kill the yt-dlp child process immediately
      const err = new Error(`${stageLabel} timed out (>${Math.round(ms / 1000)}s)`);
      err.code = "BOOMBOX_STAGE_TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function tryCleanup(tmpDir) {
  if (!tmpDir) return;
  try {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      logger.debug(`[BoomBox] Temp cleanup OK: ${tmpDir}`);
    }
  } catch (e) {
    logger.warn(`[BoomBox] Temp cleanup failed for ${tmpDir}: ${e.message}`);
  }
}

// ── Discord component helpers ─────────────────────────────────────────────────

function buildButtons(boomboxUrl) {
  // customId max = 100 chars. "bm:url:" = 7 chars; top4top URLs ~45 chars → safe.
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("🔗 Open")
      .setURL(boomboxUrl)
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setCustomId(`bm:url:${boomboxUrl}`)
      .setLabel("📋 Copy URL")
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Shown only on a failed embed — reveals the full technical detail
 * ephemerally on click instead of ever posting it into the channel. */
function buildErrorDetailButton(detailId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bm:detail:${detailId}`)
      .setLabel("🔍 Detail")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── Queue notice delivery ───────────────────────────────────────────────────
// Discord only supports true ephemeral replies on interactions — this flow
// starts from a plain text message, so there is no interaction to reply
// ephemerally to. DM the requester instead (only they see it, closest
// available equivalent to "ephemeral" here); if their DMs are closed, fall
// back to a single message in the channel that is edited in place (never
// spammed) and removed the moment their job starts.

/** @typedef {{ dm: import("discord.js").Message|null, channelMsg: import("discord.js").Message|null }} QueueNoticeState */

/** @returns {QueueNoticeState} */
function newQueueNoticeState() {
  return { dm: null, channelMsg: null };
}

async function renderQueueNotice(state, message, position, total, etaSec) {
  const embed = buildQueueEmbed(message.author, position, total, etaSec);

  if (state.dm) {
    try {
      await state.dm.edit({ embeds: [embed] });
      return;
    } catch {
      state.dm = null; // DM message gone — fall through and try again below
    }
  } else {
    try {
      state.dm = await message.author.send({ embeds: [embed] });
      return;
    } catch {
      logger.debug(`[BoomBox Queue] Could not DM ${message.author.id} — falling back to a channel notice`);
    }
  }

  // DM unavailable — use ONE channel message, edited in place per update.
  try {
    if (state.channelMsg) {
      await state.channelMsg.edit({ content: `${message.author}`, embeds: [embed] });
    } else {
      state.channelMsg = await message.channel.send({ content: `${message.author}`, embeds: [embed] });
    }
  } catch (e) {
    logger.warn(`[BoomBox Queue] Failed to render queue notice: ${e.message}`);
  }
}

async function clearQueueNotice(state) {
  if (state.dm) await state.dm.delete().catch(() => {});
  if (state.channelMsg) await state.channelMsg.delete().catch(() => {});
}

// ── BoomBox Logs System ───────────────────────────────────────────────────────
// Archive of generated BoomBox URLs only — no requester info. A single
// dashboard message is edited in place and paginated (mirrors Ticket Logs);
// see boomboxLogDashboard.js for the embed/component builders and the
// edit-or-recreate logic.

/** Newest-first entries kept in the log; older ones roll off. */
const MAX_LOG_ENTRIES = 300;

// All log-append operations are serialized through this queue so two
// BoomBox completions finishing close together can never race on the same
// read-modify-write of db.getLogState().entries — that race was the root
// cause of some successful URLs silently never reaching BoomBox Logs
// ("kadang tidak masuk ke logs").
let logAppendQueue = Promise.resolve();

/**
 * @param {{userId, platform, title, boomboxUrl, duration, timestamp}} entry
 *   Full internal entry (as stored in db.addHistory) — appendToLog strips
 *   userId/originalUrl/limitRemaining before anything reaches the channel.
 */
function appendToLog(client, entry) {
  const publicEntry = {
    title:      entry.title,
    duration:   entry.duration,
    boomboxUrl: entry.boomboxUrl,
    timestamp:  entry.timestamp,
  };

  const task = async () => {
    try {
      const state   = db.getLogState();
      const entries = [publicEntry, ...(state.entries ?? [])].slice(0, MAX_LOG_ENTRIES);
      db.setLogState({ entries });
      await updateBoomBoxLogDashboard(client, { resetToFirstPage: true });
      logger.debug(`[BoomBox] Log entry appended (${entries.length} total)`);
    } catch (e) {
      logger.error(`[BoomBox] Failed to update log: ${e.message}`);
      await logError({
        feature: "BoomBox",
        reason:  `Failed to update BoomBox Log: ${e.message}`,
        stage:   "Update BoomBox Log",
        error:   e,
      }).catch(() => {});
    }
  };

  // Chain onto the queue regardless of whether the previous task threw —
  // task() already self-catches, so this can never actually reject, but
  // .then(task, task) keeps the queue alive even if that ever changes.
  logAppendQueue = logAppendQueue.then(task, task);
  return logAppendQueue;
}

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * Entry point — call from client's messageCreate listener.
 * Returns silently when the message is not a BoomBox request.
 *
 * @param {import("discord.js").Message} message
 */
export async function handleBoomBoxMessage(message) {

  // ── [1] Guard: only the BoomBox channel ──────────────────────────────────
  if (message.channelId !== BOOMBOX_CONFIG.BOOMBOX_CHANNEL_ID) return;
  if (message.author?.bot) return;

  const content = message.content?.trim() ?? "";
  const urls    = extractUrls(content);

  if (urls.length === 0) return;

  logger.info(`[BoomBox] ▶ Request received | urls=${urls.length} | user=${message.author.id} | msg=${message.id}`);

  // ── Multiple URLs → reject ────────────────────────────────────────────────
  if (urls.length > 1) {
    await message.reply(
      "❌ Hanya **satu link** yang boleh dikirim per pesan.\n" +
      "Silakan kirim ulang dengan satu link saja."
    ).catch(() => {});
    return;
  }

  const url         = urls[0];
  const platform    = detectPlatform(url);
  const userMention = `<@${message.author.id}>`;

  logger.info(`[BoomBox] URL: ${url} | platform: ${platform ?? "UNSUPPORTED"}`);

  // ── Unsupported platform → reject (reply langsung ke pesan user) ──────────
  if (!platform) {
    await message.reply({ content: userMention, embeds: [buildUnsupportedPlatformEmbed()] }).catch(() => {});
    return;
  }

  // ── Dedup guard ───────────────────────────────────────────────────────────
  // Must be the first check before any `await` so a second duplicate event
  // is dropped synchronously — before message.delete(), role lookup, or
  // db.getUsage() are touched.
  if (processingSet.has(message.id)) {
    logger.warn(`[BoomBox] Duplicate messageCreate for ${message.id} — ignoring`);
    return;
  }
  processingSet.add(message.id);
  if (processingSet.size > MAX_DEDUP) {
    processingSet.delete(processingSet.values().next().value);
  }

  // CATATAN: message.delete() dipindah ke dalam runBoomBoxJob, SETELAH
  // message.reply() berhasil dikirim. Ini agar bot benar-benar reply ke
  // pesan user (bukan kirim pesan baru), dan baru menghapus pesan aslinya.

  // ── Role check ────────────────────────────────────────────────────────────
  const member = message.member;
  if (!member || !hasAllowedRole(member)) {
    await message.channel.send(
      `${userMention} ❌ Kamu tidak memiliki akses ke **BoomBox**.\n\n` +
      "Dibutuhkan salah satu role:\n" +
      "• **BoomBox Free**\n• **Premium**\n• **Developer**\n• **Owner**"
    ).catch(() => {});
    processingSet.delete(message.id);
    return;
  }

  const unlimited = isUnlimited(member);
  const limit     = unlimited ? null : effectiveDailyLimit(member);

  // ── Daily limit check ─────────────────────────────────────────────────────
  if (!unlimited) {
    const usage = db.getUsage(message.author.id);
    logger.info(`[BoomBox] Usage today: ${usage}/${limit} for user ${message.author.id}`);
    if (usage >= limit) {
      const limitEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("❌ BoomBox Limit")
        .setDescription(
          "━━━━━━━━━━━━━━━━━━\n\n" +
          "Kamu telah mencapai batas penggunaan hari ini.\n\n" +
          `📊 **Sisa Limit**\n0\n\n` +
          "🔄 **Reset**\nBesok\n\n" +
          "⭐ Upgrade ke **Premium** untuk mendapatkan akses BoomBox tanpa batas harian.\n\n" +
          "━━━━━━━━━━━━━━━━━━"
        );

      // Try DM first — truly private. Fall back to a channel reply that
      // auto-deletes after 10 s so other users don't see the limit notice.
      let dmSent = false;
      try {
        await message.author.send({ embeds: [limitEmbed] });
        dmSent = true;
      } catch {
        // DMs disabled — fall through to channel fallback
      }

      if (!dmSent) {
        message.reply({ embeds: [limitEmbed] })
          .then((reply) => setTimeout(() => reply.delete().catch(() => {}), 10_000))
          .catch(() => {});
      }

      processingSet.delete(message.id);
      return;
    }
  }

  // ── [2] Enter the BoomBox queue ────────────────────────────────────────────
  // At most a few jobs run at once (see boomboxQueue.js); everything beyond
  // that waits its turn FIFO. While waiting, the requester gets a private
  // (DM-first) queue notice instead of anything posted visibly in the
  // channel — see renderQueueNotice(). The visible "Processing BoomBox..."
  // embed itself is only created once this job actually starts (onStart),
  // so the channel never shows a frozen/queued job sitting there.
  const queueNotice = newQueueNoticeState();

  try {
    await enqueueBoomBoxJob(
      () => runBoomBoxJob(message, url, platform, userMention, unlimited, limit),
      {
        onQueued: (position, total, etaSec) => renderQueueNotice(queueNotice, message, position, total, etaSec),
        onStart:  () => clearQueueNotice(queueNotice),
      },
    );
  } catch (err) {
    // runBoomBoxJob is fully self-contained and never rethrows (it catches
    // its own errors and edits its own status message) — so the only way
    // this rejects is the queue's own hard ceiling (boomboxQueue.js,
    // JOB_TIMEOUT_MS) firing because something inside stalled past every
    // internal + stage-level timeout. That already frees the queue slot on
    // its own (see runWithTimeout's .finally there) and logs to Error Logs,
    // but the requester's status message is orphaned (still showing
    // whatever stage it was stuck on) since this scope no longer has a
    // reference to it. This is the last-resort safety net: without it, this
    // await would throw an unhandled rejection out of the messageCreate
    // listener and the user would never learn their job failed.
    logger.error(`[BoomBox] Job aborted by queue safety timeout for msg=${message.id}: ${err.message}`);
    await logError({
      feature: "BoomBox",
      reason:  `Job aborted by queue safety timeout: ${err.message}`,
      stage:   "Queue Safety Timeout",
      error:   err,
    }).catch(() => {});
    await message.channel.send({
      content: `${userMention} ❌ Proses BoomBox kamu gagal (timeout) dan telah dibatalkan. Silakan coba kirim link-nya lagi.`,
    }).catch(() => {});
  } finally {
    await clearQueueNotice(queueNotice);
    processingSet.delete(message.id);
  }
}

/**
 * The actual BoomBox pipeline for one request — runs only once a queue
 * slot is free. Fully self-contained: catches its own errors (never
 * rethrows) and cleans up its own temp files, so the queue itself never
 * needs to know about failures.
 */
async function runBoomBoxJob(message, url, platform, userMention, unlimited, limit) {
  // ── Reply ke pesan user dengan embed status (step 0: Menghubungkan...) ───
  // Bot REPLY ke pesan user — bukan kirim pesan baru.
  // Semua edit berikutnya menggunakan pesan reply yang sama (tidak spam).
  // Setelah reply berhasil, pesan asli user dihapus supaya channel bersih.
  let currentStage = "Send Processing Embed";
  let statusMsg;
  let lastThumbnail = null;
  try {
    statusMsg = await message.reply({ content: userMention, embeds: [buildProcessingEmbed(0, null)] });
  } catch (e) {
    logger.error(`[BoomBox] Failed to reply with processing embed: ${e.message}`);
    await logError({ feature: "BoomBox", reason: `Failed to reply with processing embed: ${e.message}`, stage: currentStage, error: e });
    processingSet.delete(message.id);
    return;
  }
  // Hapus pesan asli user setelah reply berhasil dikirim.
  // Requires Manage Messages permission; silently ignored if not granted.
  try { await message.delete(); } catch { /* no permission — continue */ }

  const startedAt = Date.now();
  let   tmpDir      = null;
  let   boomboxUrl  = null;   // set saat URL berhasil dibuat
  let   ytResult    = null;   // set saat download selesai
  let   resultSent  = false;  // true setelah result embed berhasil dikirim ke channel

  // editStep: edit embed ke tahap berikutnya tanpa delay tambahan.
  // Tahap: 0=Menghubungkan, 1=Mengambil Metadata, 2=Menyiapkan Audio,
  //        3=Upload BoomBox, 4=Verifikasi Link
  const editStep = async (step, labelOverride = null) => {
    try {
      await statusMsg.edit({ content: userMention, embeds: [buildProcessingEmbed(step, lastThumbnail, labelOverride)], components: [] });
    } catch (e) {
      logger.debug(`[BoomBox] Edit step ${step} failed (non-fatal): ${e.message}`);
    }
  };

  try {

    // ── Tahap 1: Mengambil Metadata ─────────────────────────────────────────
    currentStage = "Fetch Video Info";
    await editStep(1); // ⠹ Mengambil Metadata...

    // Spotify: resolve to a yt-dlp ytsearch query BEFORE touching any cache or
    // getVideoInfo — Spotify URLs cannot be queried by yt-dlp's --simulate.
    let downloadUrl = url;  // URL actually passed to ytdl() — may differ for Spotify
    let spotifyMeta = null;
    if (platform === "Spotify") {
      currentStage = "Resolve Spotify";
      spotifyMeta  = await withStageTimeout(resolveSpotify(url), 12_000, "Resolve Spotify track");
      downloadUrl  = spotifyMeta.ytdlInput; // "ytsearch1:<artist> - <title> official audio"
    }

    // Stable VideoID for cache keying: yt:{11-char id} | tt:{numeric id} | sp:{track id}
    const videoId = extractVideoId(url, platform);

    // ── Cache check (by VideoID) ────────────────────────────────────────────
    const cached = boomboxCache.getCachedResult(videoId);

    if (cached) {
      // ── ⚡ Cache HIT — skip getVideoInfo + download + upload entirely ─────
      currentStage = "Reuse Cached Result";
      ytResult      = cached.ytResult;
      boomboxUrl    = cached.boomboxUrl;
      lastThumbnail = ytResult?.thumbnail ?? null;
      // Record hit in persistent DB (non-blocking; fire-and-forget)
      try { db.updateVideoCacheHit(videoId); } catch {}
      logger.info(`[BoomBox] ⚡ Cache HIT | videoId=${videoId} | hitCount=${cached.hitCount} | url=${boomboxUrl}`);

    } else {
      // ── Cache MISS — fetch metadata, download, upload ────────────────────

      // Metadata cache: avoid redundant getVideoInfo() API calls for repeat misses.
      let info = boomboxCache.getCachedMeta(videoId);
      if (info) {
        logger.info(`[BoomBox] Meta cache HIT | videoId=${videoId} | title="${info.title}"`);
      } else if (platform !== "Spotify") {
        // getVideoInfo is non-fatal — failure → null duration → proceed anyway.
        info = await withStageTimeout(getVideoInfo(url), 10_000, "Analisis link (Analyzing)");
        if (info?.title || info?.duration) boomboxCache.setCachedMeta(videoId, info);
      } else {
        // Spotify: build a pseudo-info object from the oEmbed metadata we already have.
        // Duration is not available from oEmbed — skip the duration limit check.
        info = { title: spotifyMeta.title, duration: null, thumbnail: spotifyMeta.thumbnail, uploader: spotifyMeta.artist };
      }

      lastThumbnail = (spotifyMeta?.thumbnail ?? info?.thumbnail) ?? null;
      logger.info(`[BoomBox] Meta | title="${spotifyMeta?.title ?? info?.title}" duration=${info?.duration ?? "?"}s | cache=MISS`);

      // Duration limit — reject BEFORE downloading
      if (info?.duration !== null && info?.duration > MAX_DURATION_SEC) {
        logger.info(`[BoomBox] Rejected: duration ${info.duration}s > ${MAX_DURATION_SEC}s limit`);
        await statusMsg.delete().catch(() => {});
        await message.channel.send({ content: userMention, embeds: [buildDurationLimitEmbed(info.duration, MAX_DURATION_SEC)], components: [] }).catch(() => {});
        processingSet.delete(message.id);
        return;
      }

      // ── Tahap 2: Download ─────────────────────────────────────────────────
      // onProgress: fallback loop mendorong label singkat ("Trying another method...",
      // "Trying alternative API...") ke embed yang sama tanpa mengirim pesan baru.
      currentStage = "Download Audio";
      await editStep(2); // ⠼ Menyiapkan Audio...
      logger.info(`[BoomBox] ── Downloading | ${platform} | ${downloadUrl}`);
      const downloadStart = Date.now();
      ytResult = await withStageTimeout(
        (signal) => ytdl(
          downloadUrl,
          BOOMBOX_CONFIG.AUDIO_TYPE,
          BOOMBOX_CONFIG.AUDIO_QUALITY,
          (label) => editStep(2, label),
          signal,
        ),
        5 * 60_000, // 5 min ceiling — download + entire fallback chain
        "Download audio",
      );
      const downloadMs = Date.now() - downloadStart;
      tmpDir = ytResult.tmpDir;

      // Override metadata with Spotify data when applicable (ytResult may have
      // generic title like "ytsearch..." — replace with the Spotify track name).
      if (spotifyMeta) {
        ytResult = { ...ytResult, title: spotifyMeta.title ?? ytResult.title, thumbnail: spotifyMeta.thumbnail ?? ytResult.thumbnail };
      }
      lastThumbnail = ytResult.thumbnail ?? lastThumbnail;
      logger.info(`[BoomBox] ── Download OK | title="${ytResult.title}" duration=${ytResult.duration}s | provider=${ytResult.provider ?? "unknown"} | elapsed=${downloadMs}ms`);

      // ── Tahap 3: Upload BoomBox ───────────────────────────────────────────
      currentStage = "Upload to Top4Top";
      await editStep(3); // ⠦ Upload BoomBox...
      logger.info(`[BoomBox] ── Upload started | file=${ytResult.localFile}`);
      const uploadStart = Date.now();
      const t4tResult   = await withStageTimeout(top4top(ytResult.localFile), 5 * 60_000, "Upload ke Top4Top");
      const uploadMs    = Date.now() - uploadStart;

      // ── Tahap 4: Verifikasi Link ──────────────────────────────────────────
      currentStage = "Generate BoomBox URL";
      await editStep(4); // ⠇ Verifikasi Link...
      boomboxUrl = t4tResult.result;
      logger.info(`[BoomBox] ── Upload OK | BoomBox URL: ${boomboxUrl}`);

      // ── Persist to caches ─────────────────────────────────────────────────
      // 1. In-memory VideoID cache (fast path for next request)
      boomboxCache.setCachedResult(videoId, { boomboxUrl, ytResult });
      // 2. Persistent DB video cache (survives restarts)
      try {
        db.setVideoCache(videoId, {
          boomboxUrl,
          title:     ytResult.title,
          duration:  ytResult.duration,
          thumbnail: ytResult.thumbnail,
        });
      } catch {}

      // ── Stats log ─────────────────────────────────────────────────────────
      const totalMs = Date.now() - startedAt;
      logger.info(
        `[BoomBox] Stats | cache=MISS | videoId=${videoId} | platform=${platform}` +
        ` | provider=${ytResult.provider ?? "unknown"}` +
        ` | download=${downloadMs}ms | upload=${uploadMs}ms | total=${totalMs}ms`
      );
    }

    // ── Bookkeeping ────────────────────────────────────────────────────────
    if (!unlimited) db.incrementUsage(message.author.id);

    const usageAfter = unlimited ? 0 : db.getUsage(message.author.id);
    const usageInfo  = { isUnlimited: unlimited, usage: usageAfter, limit };
    const limitRemaining = unlimited ? "Unlimited" : `${Math.max(limit - usageAfter, 0)}/${limit}`;

    const entry = {
      userId:      message.author.id,
      platform,
      title:       ytResult.title ?? "Unknown",
      originalUrl: url,
      boomboxUrl,
      duration:    ytResult.duration,
      limitRemaining,
      timestamp:   new Date().toISOString(),
    };
    db.addHistory(entry);
    db.incrementStats(platform);

    // ── Sukses — hapus processing embed, kirim pesan result baru ─────────
    // Processing embed dihapus → channel bersih, tidak ada embed loading tertinggal.
    // Pesan result baru dikirim dengan mention user agar ada notifikasi Discord.
    currentStage = "Display Result";
    const elapsedMs = Date.now() - startedAt;
    const embed     = buildResultEmbed(platform, ytResult, boomboxUrl, elapsedMs, usageInfo);
    const row       = buildButtons(boomboxUrl);
    await statusMsg.delete().catch(() => {});
    await message.channel.send({
      content: userMention,
      embeds: [embed],
      components: [row],
    });
    resultSent = true;  // result berhasil dikirim — jangan kirim error setelah ini

    // ── Append to BoomBox Logs ─────────────────────────────────────────────
    currentStage = "Update BoomBox Log";
    await appendToLog(message.client, entry);

    logger.info(`[BoomBox] ✅ Completed in ${(elapsedMs / 1000).toFixed(1)}s | ${boomboxUrl}`);

  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    logger.error(`[BoomBox] ❌ Failed after ${elapsed}s at [${currentStage}]: ${err.message}`);

    // ── Kirim semua detail error HANYA ke Error Log — bukan ke channel publik ─
    // Feature, Provider, Stack, Request, Reason, Time — semuanya di sini.
    const detailId = storeErrorDetail({ message: err.message, stage: currentStage, stack: err.stack });
    await logError({
      feature: `BoomBox — ${platform}`,
      reason:  err.message,
      stage:   currentStage,
      error:   err,
    }).catch(() => {});

    // ── Jika result sudah berhasil dikirim, JANGAN kirim error lagi ──────────
    // Ini mencegah: "URL BoomBox berhasil dibuat tetapi malah dihapus lalu muncul Error"
    // yang terjadi bila appendToLog() atau operasi lain setelah channel.send() gagal.
    if (resultSent) {
      logger.warn(`[BoomBox] Error after result was delivered (stage: ${currentStage}) — not sending error to channel`);
      return;
    }

    // ── Hapus processing embed → kirim pesan error bersih ke channel ──────
    // Jangan tampilkan: Stack Trace, Provider, API, Internal Error, tombol Detail.
    // Full detail sudah dikirim ke Error Log channel via logError() di atas.
    await statusMsg.delete().catch(() => {});
    try {
      await message.channel.send({
        content: userMention,
        embeds:  [buildUserErrorEmbed()],
      });
    } catch (sendErr) {
      logger.error(`[BoomBox] Failed to send error message to channel: ${sendErr.message}`);
    }

  } finally {
    // ── [9] Temp file cleanup + dedup release ───────────────────────────────
    // Every exit from this function — success, handled failure above, or a
    // bug that somehow throws past the try/catch — must reach here so the
    // dedup guard is released. Previously this was only cleared on the
    // early-return paths before the job entered the queue; a message that
    // completed (or failed) *inside* the queue never freed its dedup slot at
    // all, relying solely on LRU eviction at MAX_DEDUP.
    tryCleanup(tmpDir);
    processingSet.delete(message.id);
  }
}
