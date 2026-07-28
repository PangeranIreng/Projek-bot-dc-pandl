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
import os from "node:os";
import path from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

import { BOOMBOX_CONFIG, ALLOWED_ROLES, UNLIMITED_ROLES } from "./config.js";
import { OWNER_ROLE_ID, DEVELOPER_ROLE_ID, PREMIUM_ROLE_ID } from "../../../config/roles.js";
import { OWNER_USER_IDS, DEVELOPER_USER_IDS } from "../../../config/owner.js";
import { ytdl, getVideoInfo }  from "../../services/ytmp3gg.js";
import { kyzzAioDownload, kyzzInstagramDownload } from "../../services/kyzzDownloader.js";
import { top4top }             from "../../services/top4top.js";
import { db, premDB }          from "../../database/db.js";
import * as boomboxCache       from "../../services/boomboxCache.js";
import { extractVideoId }      from "../../services/boomboxCache.js";
import { resolveSpotify, isSpotifyUrl } from "../../services/spotifyResolver.js";
import {
  buildDurationLimitEmbed,
  buildUserErrorEmbed,
  buildUnsupportedPlatformEmbed,
} from "./embed.js";
import {
  buildDashProcessingEmbed,
  buildDashSuccessEmbed,
  buildDashCacheEmbed,
  buildDashErrorEmbed,
  buildDashMaintenanceEmbed,
  buildDashTimeoutEmbed,
} from "./dashboardEmbed.js";
import { storeErrorDetail } from "./errorStore.js";
import { updateBoomBoxLogDashboard } from "../logs/logDashboard.js";
import { enqueueForPlatform, PRIORITY } from "../queue/boomboxQueue.js";
import { logError } from "../../utils/errorLogger.js";
import { logger }   from "../../utils/logger.js";

// ── Singletons ────────────────────────────────────────────────────────────────

/** Rolling dedup — prevents double-processing on gateway reconnects. */
const processingSet = new Set();
const MAX_DEDUP     = 200;

/** Default maximum video duration (seconds) — used when no role limit configured. */
const DEFAULT_MAX_DURATION_SEC = 25 * 60; // 25 minutes

// ── V3: Stage-level retry ─────────────────────────────────────────────────────

/**
 * Retry a failing async operation up to `maxAttempts` times with
 * exponential back-off. Does not retry on BOOMBOX_STAGE_TIMEOUT errors.
 *
 * @param {() => Promise<any>} fn
 * @param {number} maxAttempts  Default 3
 * @param {string} label        For log messages
 * @returns {Promise<any>}
 */
async function withRetry(fn, maxAttempts = 3, label = "") {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't retry hard timeouts (stage timeout already consumed the window)
      if (err?.code === "BOOMBOX_STAGE_TIMEOUT") throw err;
      if (i < maxAttempts - 1) {
        const backoffMs = 2_000 * (i + 1);
        logger.warn(`[BoomBox] ⚠ Retry ${i + 1}/${maxAttempts} for "${label}": ${err.message} — wait ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}

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
  // ── Extended platforms via Kyzz AIO ─────────────────────────────────────────
  {
    name:  "Other",
    regex: /^https?:\/\/(www\.)?(instagram\.com|threads\.net|facebook\.com|fb\.com|fb\.watch|twitter\.com|x\.com|mediafire\.com|soundcloud\.com)\//i,
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
    other:   "Other",   // optional dedicated channel for extended platforms
  };

  for (const [key, platform] of Object.entries(platformMap)) {
    if (channels[key] && channels[key] === channelId) {
      return { platform, isLegacy: false };
    }
  }

  // Fallback: legacy single channel (V1 compat) — accepts any platform including "Other"
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

// ── V3: Priority detection ────────────────────────────────────────────────────

/**
 * Determine job priority for a GuildMember.
 * Lower number = processed first.
 *   0 = Owner, 1 = Developer, 2 = Premium, 3 = Free
 */
function getJobPriority(member) {
  if (!member) return PRIORITY.FREE;
  const userId = member.id;
  if (OWNER_USER_IDS.includes(userId))     return PRIORITY.OWNER;
  if (DEVELOPER_USER_IDS.includes(userId)) return PRIORITY.DEVELOPER;
  if (member.roles.cache.has(OWNER_ROLE_ID))     return PRIORITY.OWNER;
  if (member.roles.cache.has(DEVELOPER_ROLE_ID)) return PRIORITY.DEVELOPER;
  if (member.roles.cache.has(PREMIUM_ROLE_ID))   return PRIORITY.PREMIUM;
  return PRIORITY.FREE;
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

// ── Per-platform log channel sending ─────────────────────────────────────────

const PLATFORM_COLORS = {
  YouTube: 0xff0000,
  TikTok:  0x69c9d0,
  Spotify: 0x1db954,
};

/**
 * Send a success log embed to the platform-specific log channel.
 * @param {import("discord.js").Client} client
 * @param {string} platform  "YouTube" | "TikTok" | "Spotify"
 * @param {import("discord.js").Message} message
 * @param {object} entry
 */
async function _sendPlatformLog(client, platform, message, entry) {
  const platformLogChannels = db.getPlatformLogChannels();
  const logChannelId = platformLogChannels[platform.toLowerCase()];
  if (!logChannelId) return;

  const logCh = await client.channels.fetch(logChannelId).catch(() => null);
  if (!logCh?.isTextBased()) return;

  const now          = new Date();
  const durationFmt  = entry.duration
    ? `${Math.floor(entry.duration / 60)}m ${entry.duration % 60}s`
    : "-";

  const embed = new EmbedBuilder()
    .setColor(PLATFORM_COLORS[platform] ?? 0x5865f2)
    .setTitle(`🎵 BoomBox Log — ${platform}`)
    .setDescription("━━━━━━━━━━━━━━━━━━")
    .addFields(
      { name: "Platform",    value: platform,                                                           inline: true  },
      { name: "User",        value: `${message.author.tag ?? message.author.username}\n\`${message.author.id}\``, inline: true },
      { name: "Guild",       value: message.guild?.name ?? message.guildId ?? "Unknown",                inline: true  },
      { name: "Channel",     value: `<#${message.channelId}>`,                                          inline: true  },
      { name: "Judul Lagu",  value: (entry.title ?? "Unknown").slice(0, 256),                           inline: false },
      { name: "URL Asli",    value: (entry.originalUrl ?? "-").slice(0, 512),                           inline: false },
      { name: "BoomBox URL", value: (entry.boomboxUrl  ?? "-").slice(0, 512),                           inline: false },
      { name: "Durasi",      value: durationFmt,                                                        inline: true  },
      { name: "Provider",    value: entry.provider ?? "-",                                              inline: true  },
      { name: "Status",      value: "✅ Berhasil",                                                      inline: true  },
      {
        name:   "Tanggal",
        value:  now.toLocaleDateString("id-ID", { year: "numeric", month: "long", day: "numeric" }),
        inline: true,
      },
      { name: "Jam", value: now.toLocaleTimeString("id-ID"), inline: true },
    )
    .setFooter({ text: "BoomBox V3 • Platform Log" })
    .setTimestamp();

  await logCh.send({ embeds: [embed] }).catch(err => {
    logger.warn(`[BoomBox] Gagal kirim platform log ${platform}: ${err.message}`);
  });
}

/**
 * Send a failure log embed to the platform-specific log channel.
 * @param {import("discord.js").Client} client
 * @param {string} platform
 * @param {import("discord.js").Message} message
 * @param {{ stage: string, error: Error }} info
 */
async function _sendPlatformFailureLog(client, platform, message, { stage, error }) {
  const platformLogChannels = db.getPlatformLogChannels();
  const logChannelId = platformLogChannels[platform.toLowerCase()];
  if (!logChannelId) return;

  const logCh = await client.channels.fetch(logChannelId).catch(() => null);
  if (!logCh?.isTextBased()) return;

  const now = new Date();
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`❌ BoomBox Error Log — ${platform}`)
    .setDescription("━━━━━━━━━━━━━━━━━━")
    .addFields(
      { name: "Platform", value: platform,                                                                     inline: true  },
      { name: "User",     value: `${message.author.tag ?? message.author.username}\n\`${message.author.id}\``, inline: true  },
      { name: "Guild",    value: message.guild?.name ?? message.guildId ?? "Unknown",                          inline: true  },
      { name: "Channel",  value: `<#${message.channelId}>`,                                                    inline: true  },
      { name: "Stage",    value: stage ?? "Unknown",                                                           inline: true  },
      { name: "Reason",   value: (error?.message ?? String(error)).slice(0, 512),                              inline: false },
      {
        name:   "Tanggal",
        value:  now.toLocaleDateString("id-ID", { year: "numeric", month: "long", day: "numeric" }),
        inline: true,
      },
      { name: "Jam",   value: now.toLocaleTimeString("id-ID"),                                                 inline: true  },
    )
    .setFooter({ text: "BoomBox V3 • Error Log" })
    .setTimestamp();

  await logCh.send({ embeds: [embed] }).catch(err => {
    logger.warn(`[BoomBox] Gagal kirim platform failure log ${platform}: ${err.message}`);
  });
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

/**
 * Remove any stale BoomBox temp directories left behind by a previous
 * crash or SIGKILL that prevented the normal finally-block cleanup from
 * running. Safe to call at startup; individual failures are ignored.
 *
 * Patterns cleaned: boombox-*, boombox-piped-*, boombox-inv-*,
 *                   bb-race-ytdlp-*, bb-race-ytdlc-*
 * (all created by src/services/ytmp3gg.js via fs.mkdtempSync)
 */
export function cleanupStaleBoomBoxTempDirs() {
  try {
    const tmpBase = os.tmpdir();
    const STALE_PREFIXES = ["boombox-", "boombox-piped-", "boombox-inv-", "bb-race-ytdlp-", "bb-race-ytdlc-"];
    let entries;
    try {
      entries = fs.readdirSync(tmpBase);
    } catch (e) {
      logger.warn(`[BoomBox] Temp cleanup: failed to read tmpdir: ${e.message}`);
      return;
    }

    let cleaned = 0;
    for (const entry of entries) {
      if (!STALE_PREFIXES.some(prefix => entry.startsWith(prefix))) continue;
      const fullPath = path.join(tmpBase, entry);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        cleaned++;
      } catch {
        // Ignore individual failures — may be owned by another process or already gone.
      }
    }

    if (cleaned > 0) {
      logger.info(`[BoomBox] Temp cleanup: removed ${cleaned} stale temp dir(s) from ${tmpBase}`);
    }
  } catch (e) {
    logger.warn(`[BoomBox] Temp cleanup failed: ${e.message}`);
  }
}

// ── Periodic stale-temp cleanup ───────────────────────────────────────────────
// Supplements the startup-only run: removes any dirs that accumulate during
// runtime crashes or SIGKILL events where the finally block never executes.
// Runs every 30 min, unref'd so it doesn't prevent clean process exit.
{
  const _cleanupTimer = setInterval(cleanupStaleBoomBoxTempDirs, 30 * 60_000);
  if (_cleanupTimer.unref) _cleanupTimer.unref();
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

// Queue notice removed — BoomBox memproses langsung tanpa menampilkan antrean ke user.

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
      content: userMention,
      embeds:  [buildDashMaintenanceEmbed({ userId: message.author.id })],
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

      message.channel.send({ content: `<@${message.author.id}>`, embeds: [limitEmbed] })
        .then((reply) => setTimeout(() => reply.delete().catch(() => {}), 12_000))
        .catch(() => {});
      processingSet.delete(message.id);
      return;
    }
  }

  // ── [2] Masukkan ke antrian platform worker (tanpa menampilkan queue notice) ──
  const priority = getJobPriority(member);

  try {
    await enqueueForPlatform(
      platform,
      priority,
      () => runBoomBoxJob(message, url, platform, userMention, unlimited, limit, member),
      {
        // onQueued tidak di-set — BoomBox langsung memproses tanpa notifikasi antrian
        jobId: `${platform.toLowerCase()}-${message.author.id}-${message.id}`,
      },
    );
  } catch (err) {
    logger.error(`[BoomBox] Job aborted for msg=${message.id}: ${err.message}`);
    await logError({
      feature: "BoomBox",
      reason:  `Job aborted: ${err.message}`,
      stage:   "Queue / Worker Failure",
      error:   err,
    }).catch(() => {});
    await message.channel.send({
      content: userMention,
      embeds:  [buildDashErrorEmbed({ userId: message.author.id })],
    }).catch(() => {});
  } finally {
    processingSet.delete(message.id);
  }
}

/**
 * The actual BoomBox pipeline for one request.
 * V2: menerima `member` untuk menentukan effective duration limit per role.
 */
// Label tahap pipeline untuk status proses
const STAGE_LABELS = [
  "Sedang Memproses...",    // 0 — connecting
  "Mengambil Metadata...",  // 1 — video info
  "Mengunduh Audio...",     // 2 — download
  "Mengunggah BoomBox...",  // 3 — upload
  "Memverifikasi...",       // 4 — verify
];

async function runBoomBoxJob(message, url, platform, userMention, unlimited, limit, member) {
  let currentStage = "Send Processing Embed";
  let statusMsg;
  let lastThumbnail = null;
  const userId = message.author.id;
  // Snapshot dashboard config once per job — used consistently throughout the pipeline.
  // Re-read only for the final result embed where changed settings should apply.
  const dash = db.getDashboard();

  // Konten pesan: mention user jika showMention aktif, atau string kosong
  const msgContent = dash.showMention ? userMention : "";

  // ── dashboard.enabled = false → mode teks (tidak ada styled embed) ────────
  // Saat dashboard dinonaktifkan, bot tetap berfungsi penuh tapi menggunakan
  // pesan teks biasa alih-alih embed bertata letak.
  const dashEnabled = dash.enabled !== false;

  try {
    if (dashEnabled) {
      statusMsg = await message.reply({
        content: msgContent,
        embeds:  [buildDashProcessingEmbed(userId, null, null, dash)],
      });
    } else {
      // Mode teks: satu pesan teks sederhana yang di-edit per tahap
      statusMsg = await message.reply({
        content: `${userMention}\n⏳ Sedang memproses...`,
      });
    }
  } catch (e) {
    logger.error(`[BoomBox] Failed to reply with processing embed: ${e.message}`);
    await logError({ feature: "BoomBox", reason: `Failed to reply: ${e.message}`, stage: currentStage, error: e });
    processingSet.delete(message.id);
    return;
  }
  try { await message.delete(); } catch { /* no permission — continue */ }

  const startedAt  = Date.now();
  let   tmpDir     = null;
  let   boomboxUrl = null;
  let   ytResult   = null;
  let   resultSent = false;
  let   downloadMs  = 0;   // download stage duration (0 on cache hit)
  let   uploadMs    = 0;   // upload stage duration   (0 on cache hit)
  let   spotifyMs   = 0;   // Spotify resolve duration (0 for non-Spotify)
  let   isFromCache = false;

  // V2: effective duration limit in seconds, based on member's roles
  const maxDurationSec = member
    ? db.getEffectiveDurationLimitSec(member, DEFAULT_MAX_DURATION_SEC)
    : DEFAULT_MAX_DURATION_SEC;

  const editStep = async (step, labelOverride = null) => {
    try {
      if (!dashEnabled) {
        // Mode teks: update label tahap sebagai teks biasa jika showStatus aktif
        if (dash.showStatus) {
          const label = labelOverride ?? STAGE_LABELS[Math.min(step, STAGE_LABELS.length - 1)];
          await statusMsg.edit({ content: `${userMention}\n⏳ ${label}` });
        }
        return;
      }
      // showStatus: jika nonaktif, tidak update label tahap (tetap "Sedang Memproses...")
      const label = dash.showStatus
        ? (labelOverride ?? STAGE_LABELS[Math.min(step, STAGE_LABELS.length - 1)])
        : null;
      await statusMsg.edit({
        content:    msgContent,
        embeds:     [buildDashProcessingEmbed(userId, label, lastThumbnail, dash)],
        components: [],
      });
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
      const spotifyStart = Date.now();
      spotifyMeta  = await withStageTimeout(resolveSpotify(url), 12_000, "Resolve Spotify track");
      spotifyMs    = Date.now() - spotifyStart;
      downloadUrl  = spotifyMeta.ytdlInput;
      logger.info(`[BoomBox] ── Spotify Resolve | ${spotifyMs}ms | title="${spotifyMeta.title}" artist="${spotifyMeta.artist}"`);
    }

    const videoId = extractVideoId(url, platform);
    const cached  = boomboxCache.getCachedResult(videoId);

    if (cached) {
      currentStage = "Reuse Cached Result";
      ytResult      = cached.ytResult;
      boomboxUrl    = cached.boomboxUrl;
      lastThumbnail = ytResult?.thumbnail ?? null;
      isFromCache   = true;
      try { db.updateVideoCacheHit(videoId); } catch {}
      logger.info(`[BoomBox] ⚡ Cache HIT | videoId=${videoId} | url=${boomboxUrl}`);

    } else {
      // "Other" platforms (Instagram, Facebook, Twitter/X, etc.) go straight to
      // Kyzz — getVideoInfo is yt-dlp based and won't work for them.
      let info = platform === "Other" ? null : boomboxCache.getCachedMeta(videoId);
      let infoMs = 0;
      if (platform === "Other") {
        // Metadata will be retrieved during the Kyzz download step
        logger.info(`[BoomBox] Platform=Other — skipping getVideoInfo (Kyzz AIO will retrieve metadata)`);
      } else if (info) {
        logger.info(`[BoomBox] Meta cache HIT | videoId=${videoId}`);
      } else if (platform !== "Spotify") {
        const infoStart = Date.now();
        // Allow up to 90s — getVideoInfo internally tries 4 yt-dlp methods
        // (each 20s) plus a 30s ytdl-core fallback. The old 10s cap was
        // shorter than a single method attempt, causing "Analisis link timed
        // out" on every request regardless of the actual yt-dlp result.
        // FIX: 30s is ample for getVideoInfo — it already tries 4 methods × 8s each
        // (32s max). 90s was unnecessarily long and caused the "Analisis link timed out"
        // message to appear far too late when all methods were truly blocked.
        info = await withStageTimeout(getVideoInfo(url), 30_000, "Analisis link");
        infoMs = Date.now() - infoStart;
        logger.info(`[BoomBox] ── Fetch Video Info | ${infoMs}ms | title="${info?.title ?? "null"}" dur=${info?.duration ?? "?"}s`);
        if (info?.title || info?.duration) boomboxCache.setCachedMeta(videoId, info);
      } else {
        info = { title: spotifyMeta.title, duration: null, thumbnail: spotifyMeta.thumbnail, uploader: spotifyMeta.artist };
      }

      lastThumbnail = (spotifyMeta?.thumbnail ?? info?.thumbnail) ?? null;
      logger.info(`[BoomBox] Meta | title="${spotifyMeta?.title ?? info?.title}" dur=${info?.duration ?? "?"}s`);

      // V2: Duration limit menggunakan effective limit dari role member
      // Skip duration check for "Other" platforms — duration is unknown until download
      if (platform !== "Other" && info?.duration !== null && info?.duration > maxDurationSec) {
        logger.info(`[BoomBox] Rejected: dur ${info.duration}s > ${maxDurationSec}s`);
        await statusMsg.edit({
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

      // ── Other platform: Kyzz AIO (Instagram, Facebook, Twitter/X, Mediafire, SoundCloud, Threads) ──
      const spotifySearchCandidates = spotifyMeta?.searchCandidates ?? null;
      if (platform === "Other") {
        currentStage = "Download Audio (Kyzz AIO)";
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-kyzz-"));
        const isInstagram = /instagram\.com/i.test(url);
        ytResult = await withRetry(
          () => withStageTimeout(
            (signal) => isInstagram
              ? kyzzInstagramDownload(url, tmpDir, signal)
              : kyzzAioDownload(url, tmpDir, signal),
            5 * 60_000,
            "Download audio (Kyzz AIO)",
          ),
          2,
          "Download Audio (Kyzz AIO)",
        );

      // ── Spotify: try each search candidate in sequence if the primary fails ──
      // spotifyMeta.searchCandidates is a priority-ordered list of ytsearch1: queries.
      // Without this loop, a single bad search result aborts the entire Spotify job.
      } else if (spotifySearchCandidates && spotifySearchCandidates.length > 1) {
        let spotifyDownloadErr = null;
        for (let si = 0; si < spotifySearchCandidates.length; si++) {
          const candidate = spotifySearchCandidates[si];
          if (si > 0) {
            logger.warn(`[BoomBox] ── Spotify fallback search [${si + 1}/${spotifySearchCandidates.length}]: ${candidate}`);
          }
          try {
            ytResult = await withRetry(
              () => withStageTimeout(
                (signal) => ytdl(candidate, BOOMBOX_CONFIG.AUDIO_TYPE, BOOMBOX_CONFIG.AUDIO_QUALITY, (label) => editStep(2, label), signal),
                5 * 60_000, "Download audio",
              ),
              si === 0 ? 2 : 1,  // 2 retries on primary, 1 on fallbacks
              `Download Spotify (candidate ${si + 1})`,
            );
            spotifyDownloadErr = null;
            break; // success
          } catch (err) {
            spotifyDownloadErr = err;
            logger.warn(`[BoomBox] ── Spotify search candidate ${si + 1} failed: ${err.message}`);
          }
        }
        if (spotifyDownloadErr) throw spotifyDownloadErr;
      } else {
        // Non-Spotify or single-candidate path — unchanged behaviour
        ytResult = await withRetry(
          () => withStageTimeout(
            (signal) => ytdl(
              downloadUrl,
              BOOMBOX_CONFIG.AUDIO_TYPE,
              BOOMBOX_CONFIG.AUDIO_QUALITY,
              (label) => editStep(2, label),
              signal,
            ),
            5 * 60_000,
            "Download audio",
          ),
          3,
          "Download Audio",
        );
      }

      downloadMs = Date.now() - downloadStart;
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
      const t4tResult   = await withRetry(
        () => withStageTimeout(top4top(ytResult.localFile), 5 * 60_000, "Upload ke Top4Top"),
        3,
        "Upload to Top4Top",
      );
      uploadMs          = Date.now() - uploadStart;
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
      const spotifyPart = spotifyMs > 0 ? ` | spotify=${spotifyMs}ms` : "";
      logger.info(`[BoomBox] Stats | cache=MISS | platform=${platform} | provider=${ytResult.provider ?? "unknown"}${spotifyPart} | info=${infoMs}ms | dl=${downloadMs}ms | up=${uploadMs}ms | gen=${genMs}ms | total=${totalMs}ms`);
    }

    // ── Bookkeeping ───────────────────────────────────────────────────────
    if (!unlimited) db.incrementUsage(message.author.id);

    const usageAfter     = unlimited ? 0 : db.getUsage(message.author.id);
    const usageInfo      = { isUnlimited: unlimited, usage: usageAfter, limit };
    const limitRemaining = unlimited ? "Unlimited" : `${Math.max(limit - usageAfter, 0)}/${limit}`;

    const elapsedTotal = Date.now() - startedAt;
    const entry = {
      userId:        message.author.id,
      platform,
      title:         ytResult.title ?? "Unknown",
      originalUrl:   url,
      boomboxUrl,
      duration:      ytResult.duration,
      limitRemaining,
      timestamp:     new Date().toISOString(),
      provider:      ytResult.provider ?? (boomboxUrl ? "cache" : "unknown"),
      downloadMs,
      uploadMs,
      totalMs:       elapsedTotal,
    };
    db.addHistoryAndStats(entry, platform, ytResult.provider ?? null);

    // ── Result ────────────────────────────────────────────────────────────
    currentStage = "Display Result";
    const elapsedMs = Date.now() - startedAt;
    const row       = buildButtons(boomboxUrl);

    if (!dashEnabled) {
      // Mode teks — hasil sederhana tanpa embed
      const titleShort = (ytResult.title ?? "Unknown").slice(0, 60);
      await statusMsg.edit({
        content:    `${userMention}\n✅ **${titleShort}**\n📦 ${platform}\n⬇️ ${boomboxUrl}`,
        components: [row],
      }).catch(() => {});
    } else {
      // Mode embed — gunakan dashboard config (snapshot awal job)
      let resultEmbed;
      if (isFromCache) {
        const savedEntry = db.getVideoCache(extractVideoId(url, platform));
        const savedAt    = savedEntry?.createdAt
          ? new Date(savedEntry.createdAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) + " WIB"
          : "Sebelumnya";
        resultEmbed = buildDashCacheEmbed({
          userId:      message.author.id,
          title:       ytResult.title,
          artist:      ytResult.uploader ?? null,
          platform,
          boomboxUrl,
          thumbnail:   ytResult.thumbnail ?? null,
          elapsedMs,
          savedAt,
          dashOverride: dash,
        });
      } else {
        resultEmbed = buildDashSuccessEmbed({
          userId:      message.author.id,
          title:       ytResult.title,
          artist:      ytResult.uploader ?? null,
          platform,
          boomboxUrl,
          thumbnail:   ytResult.thumbnail ?? null,
          elapsedMs,
          fromCache:   false,
          dashOverride: dash,
        });
      }
      await statusMsg.edit({ content: msgContent, embeds: [resultEmbed], components: [row] }).catch(() => {});
    }
    resultSent = true;

    // ── Append to BoomBox Logs ────────────────────────────────────────────
    currentStage = "Update BoomBox Log";
    await appendToLog(message.client, entry);

    // ── Send to per-platform log channel ──────────────────────────────────
    await _sendPlatformLog(message.client, platform, message, entry).catch(() => {});

    logger.info(`[BoomBox] ✅ Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s | ${boomboxUrl}`);

  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    logger.error(`[BoomBox] ❌ Failed after ${elapsed}s at [${currentStage}]: ${err.message}`);

    const detailId = storeErrorDetail({ message: err.message, stage: currentStage, stack: err.stack });
    try { db.incrementFailureStats(platform); } catch {} // non-fatal sync call
    await logError({
      feature:  `BoomBox — ${platform}`,
      reason:   err.message,
      stage:    currentStage,
      error:    err,
      provider: ytResult?.provider ?? "unknown",
    }).catch(() => {});

    // Send failure to platform-specific log channel
    await _sendPlatformFailureLog(message.client, platform ?? "Unknown", message, {
      stage: currentStage,
      error: err,
    }).catch(() => {});

    if (resultSent) {
      logger.warn(`[BoomBox] Error after result delivered (stage: ${currentStage}) — skip error channel msg`);
      return;
    }

    try {
      const isTimeout = err?.code === "BOOMBOX_STAGE_TIMEOUT";
      if (!dashEnabled) {
        // Mode teks — pesan error sederhana
        const label = isTimeout ? "⌛ Waktu pemrosesan habis. Silakan coba lagi." : "❌ Gagal diproses. Silakan coba lagi.";
        await statusMsg.edit({ content: `${userMention}\n${label}`, components: [] });
      } else {
        const errEmbed = isTimeout
          ? buildDashTimeoutEmbed({ userId: message.author.id, dashOverride: dash })
          : buildDashErrorEmbed({ userId: message.author.id, dashOverride: dash });
        await statusMsg.edit({ content: msgContent, embeds: [errEmbed], components: [] });
      }
    } catch (editErr) {
      logger.error(`[BoomBox] Failed to edit error embed: ${editErr.message}`);
    }

  } finally {
    tryCleanup(tmpDir);
    processingSet.delete(message.id);
  }
}
