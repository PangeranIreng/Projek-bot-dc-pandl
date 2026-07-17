/**
 * boomboxHandler.js — Main BoomBox message handler (V2).
 *
 * Pipeline (engine lama tidak diubah):
 *   [1]  Request received — validate channel / role / URL / daily limit
 *   [2]  getVideoInfo()  — fast metadata fetch, duration check (per-role limit)
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
 * V2 Changes:
 *   - Channel check: baca dari DB (per platform) + fallback ke config hardcode
 *   - Maintenance check: cek DB sebelum proses
 *   - Duration limit: gunakan db.getEffectiveDurationLimitSec(member)
 *   - Fallback message jika channel belum di-setup
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

/** Rolling dedup — prevents double-processing on gateway reconnects. */
const processingSet = new Set();
const MAX_DEDUP     = 200;

/** Default maximum video duration (seconds) — used when no role limit configured. */
const DEFAULT_MAX_DURATION_SEC = 25 * 60; // 25 minutes

// ── URL helpers ───────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>"]+/gi;

const PLATFORM_PATTERNS = [
  {
    name:  "YouTube",
    regex: /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts|live)|youtu\.be\/|music\.youtube\.com\/watch)/i,
  },
  {
    name:  "TikTok",
    regex: /^https?:\/\/([a-z0-9-]+\.)?tiktok\.com\//i,
  },
  {
    name:  "Spotify",
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

// ── V2: Channel & Maintenance helpers ─────────────────────────────────────────

/**
 * Resolve which BoomBox platform (if any) the given channelId belongs to.
 * Returns { platform: string, isLegacy: boolean } or null if not a BoomBox channel.
 *
 * Priority:
 *   1. DB-configured per-platform channels
 *   2. Legacy hardcoded BOOMBOX_CHANNEL_ID (all platforms, backward compat)
 */
function resolveBoomBoxChannel(channelId) {
  const channels = db.getChannels();

  // Check DB channels first (V2)
  const platformMap = {
    youtube: "YouTube",
    tiktok:  "TikTok",
    spotify: "Spotify",
  };

  for (const [key, platform] of Object.entries(platformMap)) {
    if (channels[key] && channels[key] === channelId) {
      return { platform, isLegacy: false };
    }
  }

  // Fallback: legacy single channel (V1 compat)
  const legacyId = BOOMBOX_CONFIG.BOOMBOX_CHANNEL_ID;
  if (legacyId && legacyId === channelId) {
    return { platform: null, isLegacy: true }; // any platform accepted
  }

  return null; // not a BoomBox channel
}

/**
 * Check whether a platform is in maintenance.
 * @param {"YouTube"|"TikTok"|"Spotify"} platform
 * @returns {boolean}
 */
function isPlatformInMaintenance(platform) {
  const maint = db.getMaintenance();
  return maint[platform.toLowerCase()] === true;
}

// ── Role / Premium helpers ────────────────────────────────────────────────────

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

/** Highest applicable daily limit for a non-unlimited member. */
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

function withStageTimeout(promiseOrFactory, ms, stageLabel) {
  const isFactory  = typeof promiseOrFactory === "function";
  const controller = isFactory ? new AbortController() : null;
  const work       = isFactory ? promiseOrFactory(controller.signal) : promiseOrFactory;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
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

function buildErrorDetailButton(detailId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bm:detail:${detailId}`)
      .setLabel("🔍 Detail")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── Queue notice delivery ─────────────────────────────────────────────────────

function newQueueNoticeState() {
  return { dm: null, channelMsg: null };
}

async function renderQueueNotice(state, message, position, total, etaSec) {
  const embed = buildQueueEmbed(message.author, position, total, etaSec);

  if (state.dm) {
    try { await state.dm.edit({ embeds: [embed] }); return; } catch { state.dm = null; }
  } else {
    try { state.dm = await message.author.send({ embeds: [embed] }); return; } catch {
      logger.debug(`[BoomBox Queue] Could not DM ${message.author.id} — channel fallback`);
    }
  }

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
  if (state.dm)         await state.dm.delete().catch(() => {});
  if (state.channelMsg) await state.channelMsg.delete().catch(() => {});
}

// ── BoomBox Logs System ───────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 300;
let logAppendQueue = Promise.resolve();

function appendToLog(client, entry) {
  const publicEntry = {
    title:      entry.title,
    platform:   entry.platform,
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

  // ── [1] Guard: channel check (V2 — DB + legacy fallback) ─────────────────
  const channelInfo = resolveBoomBoxChannel(message.channelId);
  if (!channelInfo) return;
  if (message.author?.bot) return;

  const content = message.content?.trim() ?? "";
  const urls    = extractUrls(content);
  if (urls.length === 0) return;

  logger.info(`[BoomBox] ▶ Request | urls=${urls.length} | user=${message.author.id} | msg=${message.id}`);

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

  // ── V2: Platform-channel mismatch check ───────────────────────────────────
  // Jika channel dikonfigurasi hanya untuk satu platform,
  // tolak URL yang tidak sesuai.
  if (!channelInfo.isLegacy && channelInfo.platform && platform !== channelInfo.platform) {
    // Hapus pesan user (jangan mention user di reply)
    try { await message.delete(); } catch { /* no permission — continue */ }

    // Ambil channel ID per-platform dari DB untuk mention yang tepat
    const configuredChannels = db.getChannels();
    const ytCh  = configuredChannels.youtube ? `<#${configuredChannels.youtube}>` : "#🔴・create-boombox";
    const tkCh  = configuredChannels.tiktok  ? `<#${configuredChannels.tiktok}>`  : "#🎶・boombox-tiktok";
    const spCh  = configuredChannels.spotify ? `<#${configuredChannels.spotify}>` : "#🎧・boombox-spotify";

    const notifContent =
      "❌ Link tersebut tidak dapat diproses di channel ini.\n\n" +
      "Silakan kirim ke:\n\n" +
      `🔴 ${ytCh}\n` +
      `🎶 ${tkCh}\n` +
      `🎧 ${spCh}\n\n` +
      "sesuai platform.";

    // Kirim pesan tanpa mention, auto-delete setelah 8 detik
    message.channel.send({ content: notifContent })
      .then(msg => setTimeout(() => msg.delete().catch(() => {}), 8_000))
      .catch(() => {});
    return;
  }

  // ── Unsupported platform ──────────────────────────────────────────────────
  if (!platform) {
    await message.reply({ content: userMention, embeds: [buildUnsupportedPlatformEmbed()] }).catch(() => {});
    return;
  }

  // ── V2: Maintenance check ─────────────────────────────────────────────────
  if (isPlatformInMaintenance(platform)) {
    await message.reply({
      content:
        `${userMention}\n\n` +
        `🚧 **BoomBox ${platform} sedang maintenance.**\n\n` +
        "Silakan coba lagi beberapa saat lagi.",
    }).catch(() => {});
    return;
  }

  // ── Dedup guard ───────────────────────────────────────────────────────────
  if (processingSet.has(message.id)) {
    logger.warn(`[BoomBox] Duplicate messageCreate for ${message.id} — ignoring`);
    return;
  }
  processingSet.add(message.id);
  if (processingSet.size > MAX_DEDUP) {
    processingSet.delete(processingSet.values().next().value);
  }

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

      let dmSent = false;
      try { await message.author.send({ embeds: [limitEmbed] }); dmSent = true; } catch {}
      if (!dmSent) {
        message.reply({ embeds: [limitEmbed] })
          .then((reply) => setTimeout(() => reply.delete().catch(() => {}), 10_000))
          .catch(() => {});
      }
      processingSet.delete(message.id);
      return;
    }
  }

  // ── [2] Enter the BoomBox queue ───────────────────────────────────────────
  const queueNotice = newQueueNoticeState();

  try {
    await enqueueBoomBoxJob(
      () => runBoomBoxJob(message, url, platform, userMention, unlimited, limit, member),
      {
        onQueued: (position, total, etaSec) => renderQueueNotice(queueNotice, message, position, total, etaSec),
        onStart:  () => clearQueueNotice(queueNotice),
      },
    );
  } catch (err) {
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
 * The actual BoomBox pipeline for one request.
 * V2: menerima `member` untuk menentukan effective duration limit per role.
 */
async function runBoomBoxJob(message, url, platform, userMention, unlimited, limit, member) {
  let currentStage = "Send Processing Embed";
  let statusMsg;
  let lastThumbnail = null;
  try {
    statusMsg = await message.reply({ content: userMention, embeds: [buildProcessingEmbed(0, null)] });
  } catch (e) {
    logger.error(`[BoomBox] Failed to reply with processing embed: ${e.message}`);
    await logError({ feature: "BoomBox", reason: `Failed to reply: ${e.message}`, stage: currentStage, error: e });
    processingSet.delete(message.id);
    return;
  }
  try { await message.delete(); } catch { /* no permission — continue */ }

  const startedAt = Date.now();
  let   tmpDir      = null;
  let   boomboxUrl  = null;
  let   ytResult    = null;
  let   resultSent  = false;

  // V2: effective duration limit in seconds, based on member's roles
  const maxDurationSec = member
    ? db.getEffectiveDurationLimitSec(member, DEFAULT_MAX_DURATION_SEC)
    : DEFAULT_MAX_DURATION_SEC;

  const editStep = async (step, labelOverride = null) => {
    try {
      await statusMsg.edit({ content: userMention, embeds: [buildProcessingEmbed(step, lastThumbnail, labelOverride)], components: [] });
    } catch (e) {
      logger.debug(`[BoomBox] Edit step ${step} failed (non-fatal): ${e.message}`);
    }
  };

  try {

    // ── Tahap 1: Metadata ─────────────────────────────────────────────────
    currentStage = "Fetch Video Info";
    await editStep(1);

    let downloadUrl = url;
    let spotifyMeta = null;
    if (platform === "Spotify") {
      currentStage = "Resolve Spotify";
      spotifyMeta  = await withStageTimeout(resolveSpotify(url), 12_000, "Resolve Spotify track");
      downloadUrl  = spotifyMeta.ytdlInput;
    }

    const videoId = extractVideoId(url, platform);
    const cached  = boomboxCache.getCachedResult(videoId);

    if (cached) {
      currentStage = "Reuse Cached Result";
      ytResult      = cached.ytResult;
      boomboxUrl    = cached.boomboxUrl;
      lastThumbnail = ytResult?.thumbnail ?? null;
      try { db.updateVideoCacheHit(videoId); } catch {}
      logger.info(`[BoomBox] ⚡ Cache HIT | videoId=${videoId} | url=${boomboxUrl}`);

    } else {
      let info = boomboxCache.getCachedMeta(videoId);
      let infoMs = 0;
      if (info) {
        logger.info(`[BoomBox] Meta cache HIT | videoId=${videoId}`);
      } else if (platform !== "Spotify") {
        const infoStart = Date.now();
        // Allow up to 90s — getVideoInfo internally tries 4 yt-dlp methods
        // (each 20s) plus a 30s ytdl-core fallback. The old 10s cap was
        // shorter than a single method attempt, causing "Analisis link timed
        // out" on every request regardless of the actual yt-dlp result.
        info = await withStageTimeout(getVideoInfo(url), 90_000, "Analisis link");
        infoMs = Date.now() - infoStart;
        logger.info(`[BoomBox] ── Fetch Video Info | ${infoMs}ms | title="${info?.title ?? "null"}" dur=${info?.duration ?? "?"}s`);
        if (info?.title || info?.duration) boomboxCache.setCachedMeta(videoId, info);
      } else {
        info = { title: spotifyMeta.title, duration: null, thumbnail: spotifyMeta.thumbnail, uploader: spotifyMeta.artist };
      }

      lastThumbnail = (spotifyMeta?.thumbnail ?? info?.thumbnail) ?? null;
      logger.info(`[BoomBox] Meta | title="${spotifyMeta?.title ?? info?.title}" dur=${info?.duration ?? "?"}s`);

      // V2: Duration limit menggunakan effective limit dari role member
      if (info?.duration !== null && info?.duration > maxDurationSec) {
        logger.info(`[BoomBox] Rejected: dur ${info.duration}s > ${maxDurationSec}s`);
        await statusMsg.delete().catch(() => {});
        await message.channel.send({
          content:    userMention,
          embeds:     [buildDurationLimitEmbed(info.duration, maxDurationSec)],
          components: [],
        }).catch(() => {});
        processingSet.delete(message.id);
        return;
      }

      // ── Tahap 2: Download ─────────────────────────────────────────────
      currentStage = "Download Audio";
      await editStep(2);
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
        5 * 60_000,
        "Download audio",
      );
      const downloadMs = Date.now() - downloadStart;
      tmpDir = ytResult.tmpDir;

      if (spotifyMeta) {
        ytResult = { ...ytResult, title: spotifyMeta.title ?? ytResult.title, thumbnail: spotifyMeta.thumbnail ?? ytResult.thumbnail };
      }
      lastThumbnail = ytResult.thumbnail ?? lastThumbnail;
      logger.info(`[BoomBox] ── Download OK | title="${ytResult.title}" | ${downloadMs}ms`);

      // ── Tahap 3: Upload ───────────────────────────────────────────────
      currentStage = "Upload to Top4Top";
      await editStep(3);
      const uploadStart = Date.now();
      const t4tResult   = await withStageTimeout(top4top(ytResult.localFile), 5 * 60_000, "Upload ke Top4Top");
      const uploadMs    = Date.now() - uploadStart;
      logger.info(`[BoomBox] ── Upload Top4Top | ${uploadMs}ms`);

      // ── Tahap 4: Verifikasi ───────────────────────────────────────────
      currentStage = "Generate BoomBox URL";
      await editStep(4);
      const genStart = Date.now();
      boomboxUrl = t4tResult.result;
      const genMs = Date.now() - genStart;
      logger.info(`[BoomBox] ── Generate BoomBox URL | ${genMs}ms | ${boomboxUrl}`);

      // ── Persist to caches ─────────────────────────────────────────────
      boomboxCache.setCachedResult(videoId, { boomboxUrl, ytResult });
      try {
        db.setVideoCache(videoId, { boomboxUrl, title: ytResult.title, duration: ytResult.duration, thumbnail: ytResult.thumbnail });
      } catch {}

      const totalMs = Date.now() - startedAt;
      logger.info(`[BoomBox] Stats | cache=MISS | platform=${platform} | info=${infoMs}ms | dl=${downloadMs}ms | up=${uploadMs}ms | gen=${genMs}ms | total=${totalMs}ms`);
    }

    // ── Bookkeeping ───────────────────────────────────────────────────────
    if (!unlimited) db.incrementUsage(message.author.id);

    const usageAfter     = unlimited ? 0 : db.getUsage(message.author.id);
    const usageInfo      = { isUnlimited: unlimited, usage: usageAfter, limit };
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

    // ── Result ────────────────────────────────────────────────────────────
    currentStage = "Display Result";
    const elapsedMs = Date.now() - startedAt;
    const embed     = buildResultEmbed(platform, ytResult, boomboxUrl, elapsedMs, usageInfo);
    const row       = buildButtons(boomboxUrl);
    await statusMsg.delete().catch(() => {});
    await message.channel.send({ content: userMention, embeds: [embed], components: [row] });
    resultSent = true;

    // ── Append to BoomBox Logs ────────────────────────────────────────────
    currentStage = "Update BoomBox Log";
    await appendToLog(message.client, entry);

    logger.info(`[BoomBox] ✅ Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s | ${boomboxUrl}`);

  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    logger.error(`[BoomBox] ❌ Failed after ${elapsed}s at [${currentStage}]: ${err.message}`);

    const detailId = storeErrorDetail({ message: err.message, stage: currentStage, stack: err.stack });
    await logError({
      feature: `BoomBox — ${platform}`,
      reason:  err.message,
      stage:   currentStage,
      error:   err,
    }).catch(() => {});

    if (resultSent) {
      logger.warn(`[BoomBox] Error after result delivered (stage: ${currentStage}) — skip error channel msg`);
      return;
    }

    await statusMsg.delete().catch(() => {});
    try {
      await message.channel.send({ content: userMention, embeds: [buildUserErrorEmbed()] });
    } catch (sendErr) {
      logger.error(`[BoomBox] Failed to send error to channel: ${sendErr.message}`);
    }

  } finally {
    tryCleanup(tmpDir);
    processingSet.delete(message.id);
  }
}
