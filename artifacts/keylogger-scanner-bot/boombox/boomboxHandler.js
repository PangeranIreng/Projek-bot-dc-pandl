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

import { BOOMBOX_CONFIG, ALLOWED_ROLES, UNLIMITED_ROLES } from "./boomboxConfig.js";
import { ytdl, getVideoInfo } from "./ytmp3gg.js";
import { top4top }            from "./top4top.js";
import { db, premDB }         from "./db.js";
import {
  buildProcessingEmbed,
  buildResultEmbed,
  buildDurationLimitEmbed,
  buildErrorEmbed,
  buildQueueEmbed,
} from "./boomboxEmbed.js";
import { storeErrorDetail } from "./boomboxErrorStore.js";
import { updateBoomBoxLogDashboard } from "./boomboxLogDashboard.js";
import { enqueueBoomBoxJob } from "./boomboxQueue.js";
import { logError } from "../utils/errorLogger.js";
import { logger }   from "../utils/logger.js";

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
// Same source URL requested again within the TTL skips download+upload
// entirely and reuses the previous BoomBox URL -- avoids duplicate downloads
// and makes repeat requests near-instant.
const RESULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_RESULT_CACHE    = 300;
const resultCache = new Map(); // url -> { ytResult, boomboxUrl, timestamp }

function getCachedResult(url) {
  const hit = resultCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.timestamp > RESULT_CACHE_TTL_MS) {
    resultCache.delete(url);
    return null;
  }
  return hit;
}

function setCachedResult(url, ytResult, boomboxUrl) {
  resultCache.set(url, { ytResult, boomboxUrl, timestamp: Date.now() });
  if (resultCache.size > MAX_RESULT_CACHE) {
    resultCache.delete(resultCache.keys().next().value);
  }
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
    // Covers any tiktok.com subdomain: tiktok.com, www., m., vt., vm., music., etc.
    regex: /^https?:\/\/([a-z0-9-]+\.)?tiktok\.com\//i,
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

/** Small delay so status transitions read as a smooth process instead of an
 * instant flicker. Kept short to minimise total processing time. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function smoothDelay() {
  return sleep(100 + Math.floor(Math.random() * 100)); // 100–200ms
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

  const url      = urls[0];
  const platform = detectPlatform(url);

  logger.info(`[BoomBox] URL: ${url} | platform: ${platform ?? "UNSUPPORTED"}`);

  // ── Unsupported platform → reject ─────────────────────────────────────────
  if (!platform) {
    await message.reply(
      "❌ **Platform tidak didukung.**\n\n" +
      "BoomBox saat ini mendukung:\n" +
      "• **YouTube** (youtube.com, youtu.be, YouTube Music)\n" +
      "• **TikTok** (tiktok.com, m.tiktok.com, vt.tiktok.com, vm.tiktok.com)\n\n" +
      "Pastikan link yang kamu kirim valid dan coba lagi."
    ).catch(() => {});
    return;
  }

  // ── Dedup guard ───────────────────────────────────────────────────────────
  // Must be the first check before any `await` so a second duplicate event
  // is dropped synchronously — before message.delete(), role lookup, or
  // db.getUsage() are touched. Previously this sat after `await message.delete()`,
  // which opened an async gap where both duplicate events could each call
  // delete/role-check/getUsage before either reached the guard.
  if (processingSet.has(message.id)) {
    logger.warn(`[BoomBox] Duplicate messageCreate for ${message.id} — ignoring`);
    return;
  }
  processingSet.add(message.id);
  if (processingSet.size > MAX_DEDUP) {
    processingSet.delete(processingSet.values().next().value);
  }

  // ── Delete user's original message ───────────────────────────────────────
  // Requires Manage Messages permission; silently ignored if not granted.
  try { await message.delete(); } catch { /* no permission — continue */ }

  const userMention = `<@${message.author.id}>`;

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

  await enqueueBoomBoxJob(
    () => runBoomBoxJob(message, url, platform, userMention, unlimited, limit),
    {
      onQueued: (position, total, etaSec) => renderQueueNotice(queueNotice, message, position, total, etaSec),
      onStart:  () => clearQueueNotice(queueNotice),
    },
  );
}

/**
 * The actual BoomBox pipeline for one request — runs only once a queue
 * slot is free. Fully self-contained: catches its own errors (never
 * rethrows) and cleans up its own temp files, so the queue itself never
 * needs to know about failures.
 */
async function runBoomBoxJob(message, url, platform, userMention, unlimited, limit) {
  // ── Send ONE temporary status embed immediately ───────────────────────────
  // Everything after this point edits this same message — never sends a new
  // one — so the channel never gets spammed with progress messages.
  let currentStage = "Send Processing Embed";
  let statusMsg;
  let lastThumbnail = null;
  try {
    statusMsg = await message.channel.send({ content: userMention, embeds: [buildProcessingEmbed(0, null)] });
  } catch (e) {
    logger.error(`[BoomBox] Failed to send processing embed: ${e.message}`);
    await logError({ feature: "BoomBox", reason: `Failed to send processing embed: ${e.message}`, stage: currentStage, error: e });
    processingSet.delete(message.id);
    return;
  }

  const startedAt = Date.now();
  let   tmpDir    = null;

  // Awaited (not fire-and-forget) + a small randomized delay so status
  // transitions read as a smooth, professional-looking process instead of a
  // flicker, per spec. editStep never throws (catches internally).
  const editStep = async (step, labelOverride = null) => {
    try {
      await statusMsg.edit({ content: userMention, embeds: [buildProcessingEmbed(step, lastThumbnail, labelOverride)], components: [] });
      await smoothDelay();
    } catch (e) {
      logger.debug(`[BoomBox] Edit step ${step} failed (non-fatal): ${e.message}`);
    }
  };

  try {

    // ── [3] Fetching video metadata ──────────────────────────────────────
    // Same URL cached from a recent request? Reuse its metadata + skip the
    // network fetch too.
    currentStage = "Fetch Video Info";
    await editStep(1); // "Fetching video..."
    const cachedEarly = getCachedResult(url);
    const info = cachedEarly ? cachedEarly.ytResult : await getVideoInfo(url);
    lastThumbnail = info.thumbnail ?? null;
    if (cachedEarly) {
      logger.info(`[BoomBox] Cache hit for ${url} — reusing metadata`);
    } else {
      logger.info(`[BoomBox] Fetching video info (simulate)...`);
    }
    logger.info(`[BoomBox] Video info | title="${info.title}" duration=${info.duration}s`);

    // Duration limit — reject BEFORE downloading
    if (info.duration !== null && info.duration > MAX_DURATION_SEC) {
      logger.info(`[BoomBox] Rejected: duration ${info.duration}s > ${MAX_DURATION_SEC}s limit`);
      await statusMsg.edit({ content: userMention, embeds: [buildDurationLimitEmbed(info.duration, MAX_DURATION_SEC)], components: [] }).catch(() => {});
      processingSet.delete(message.id);
      return;
    }

    let ytResult, boomboxUrl;
    const cached = getCachedResult(url);

    if (cached) {
      // ── Cache hit — skip download + upload entirely ──────────────────────
      currentStage = "Reuse Cached Result";
      logger.info(`[BoomBox] ── Reusing cached BoomBox URL for ${url} (no download/upload needed)`);
      ytResult   = cached.ytResult;
      boomboxUrl = cached.boomboxUrl;
    } else {
      // ── [4] Downloading / extracting audio ───────────────────────────────
      // onProgress lets the retry loop inside ytdl() (multi-method YouTube/
      // TikTok fallback, last-resort recovery engine) push live status text
      // ("Trying another method...", "Recovering download...") onto this
      // same message instead of leaving the user staring at a frozen embed.
      currentStage = "Download Audio";
      await editStep(2); // "Extracting audio..."
      logger.info(`[BoomBox] ── Downloading | ${platform} | ${url}`);
      ytResult = await ytdl(
        url,
        BOOMBOX_CONFIG.AUDIO_TYPE,
        BOOMBOX_CONFIG.AUDIO_QUALITY,
        (label) => editStep(2, label),
      );
      tmpDir = ytResult.tmpDir;
      lastThumbnail = ytResult.thumbnail ?? lastThumbnail;
      logger.info(`[BoomBox] ── Download complete | title="${ytResult.title}" duration=${ytResult.duration}s`);

      // ── [5] Uploading ───────────────────────────────────────────────────
      currentStage = "Upload to Top4Top";
      await editStep(3);
      logger.info(`[BoomBox] ── Upload started | file=${ytResult.localFile}`);
      const t4tResult = await top4top(ytResult.localFile);

      // ── [6] BoomBox URL ─────────────────────────────────────────────────
      currentStage = "Generate BoomBox URL";
      await editStep(4);
      boomboxUrl = t4tResult.result;
      logger.info(`[BoomBox] ── Upload finished | BoomBox URL created: ${boomboxUrl}`);

      setCachedResult(url, ytResult, boomboxUrl);
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

    // ── [7] Success — delete the processing embed, send a BRAND NEW message ──
    // Editing the processing message into the result was the old behavior;
    // per spec this now deletes it and sends a fresh message that @mentions
    // the requester, so they get a real notification even if they've
    // switched to another channel (an edit to an old message does not
    // re-notify Discord clients the way a new mention does).
    currentStage = "Display Result";
    const elapsedMs = Date.now() - startedAt;
    const embed     = buildResultEmbed(platform, ytResult, boomboxUrl, elapsedMs, usageInfo);
    const row       = buildButtons(boomboxUrl);
    await statusMsg.delete().catch(() => {});
    await message.channel.send({
      content: `${userMention} ✅ **BoomBox Ready** — your BoomBox URL has been created successfully.`,
      embeds: [embed],
      components: [row],
    });

    // ── [8] Append to BoomBox Logs ─────────────────────────────────────────
    currentStage = "Update BoomBox Log";
    await appendToLog(message.client, entry);

    logger.info(`[BoomBox] ✅ Completed in ${(elapsedMs / 1000).toFixed(1)}s | ${boomboxUrl}`);

  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    logger.error(`[BoomBox] ❌ Failed after ${elapsed}s at [${currentStage}]: ${err.message}`);

    // Send to global error logger (full stack trace — error-log channel only)
    await logError({
      feature: `BoomBox — ${platform}`,
      reason:  err.message,
      stage:   currentStage,
      error:   err,
    });

    // The channel embed itself never carries a stack trace — only the
    // summarized reason/suggestion. Full detail is stashed here and only
    // revealed ephemerally if someone clicks "🔍 Detail".
    const detailId = storeErrorDetail({ message: err.message, stage: currentStage, stack: err.stack });

    try {
      await statusMsg.edit({
        content:    userMention,
        embeds:     [buildErrorEmbed(err)],
        components: [buildErrorDetailButton(detailId)],
      });
    } catch (editErr) {
      logger.error(`[BoomBox] Also failed to edit error reply: ${editErr.message}`);
    }

  } finally {
    // ── [9] Temp file cleanup ──────────────────────────────────────────────
    tryCleanup(tmpDir);
  }
}
