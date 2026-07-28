/**
 * ulangHandler.js — !ulang command: regenerate BoomBox URL.
 *
 * Usage:
 *   1. Reply to a BoomBox result message → ketik !ulang
 *   2. !ulang <url>  (directly with URL)
 *
 * Forces fresh download + upload (invalidates old cache entry).
 */

import fs   from "node:fs";
import path from "node:path";
import os   from "node:os";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

import { db }             from "../../database/db.js";
import * as boomboxCache  from "../../services/boomboxCache.js";
import { extractVideoId, deleteCachedResult } from "../../services/boomboxCache.js";
import { top4top }        from "../../services/top4top.js";
import { ytdl }           from "../../services/ytmp3gg.js";
import { kyzzYtAudio, kyzzAioDownload } from "../../services/kyzzDownloader.js";
import { enqueueForPlatform, PRIORITY } from "../queue/boomboxQueue.js";
import { logger }         from "../../utils/logger.js";
import { logError }       from "../../utils/errorLogger.js";
import { BOOMBOX_CONFIG } from "../boombox/config.js";

const URL_RE = /https?:\/\/[^\s<>"]+/gi;

// ── Platform detection ────────────────────────────────────────────────────────

const PLATFORM_PATTERNS = [
  { name: "YouTube", regex: /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts|live)|youtu\.be\/|music\.youtube\.com\/watch)/i },
  { name: "TikTok",  regex: /^https?:\/\/([a-z0-9-]+\.)?tiktok\.com\//i },
  { name: "Spotify", regex: /^https?:\/\/open\.spotify\.com\/track\//i },
];

function detectPlatform(url) {
  for (const p of PLATFORM_PATTERNS) {
    if (p.regex.test(url)) return p.name;
  }
  return "Other";
}

function extractUrls(text) {
  return [...((text ?? "").match(URL_RE) ?? [])];
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Handle !ulang command from messageCreate event.
 * Returns true if this message was handled.
 *
 * @param {import("discord.js").Message} message
 * @returns {Promise<boolean>}
 */
export async function handleUlangCommand(message) {
  const content = message.content?.trim() ?? "";
  if (!content.toLowerCase().startsWith("!ulang")) return false;

  // ── Resolve target URL ────────────────────────────────────────────────────
  let targetUrl = null;

  // 1. URL in command args: !ulang <url>
  const cmdText = content.slice(6).trim();
  const cmdUrls = extractUrls(cmdText);
  if (cmdUrls.length > 0) targetUrl = cmdUrls[0];

  // 2. URL from replied-to message
  if (!targetUrl && message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      // Check embeds first (BoomBox result embed has URL in fields/description)
      for (const embed of ref.embeds ?? []) {
        for (const field of embed.fields ?? []) {
          const fUrls = extractUrls(field.value);
          if (fUrls.length > 0) { targetUrl = fUrls[0]; break; }
        }
        if (targetUrl) break;
        const descUrls = extractUrls(embed.description ?? "");
        if (descUrls.length > 0) { targetUrl = descUrls[0]; break; }
      }
      // Fallback: check message text
      if (!targetUrl) {
        const refUrls = extractUrls(ref.content ?? "");
        if (refUrls.length > 0) targetUrl = refUrls[0];
      }
    } catch {
      // Can't fetch reference — continue
    }
  }

  if (!targetUrl) {
    await message.reply(
      "❌ **!ulang** — URL tidak ditemukan.\n\n" +
      "**Cara pakai:**\n" +
      "• Reply ke pesan BoomBox → ketik `!ulang`\n" +
      "• Atau langsung: `!ulang <url>`"
    ).catch(() => {});
    return true;
  }

  const platform = detectPlatform(targetUrl);
  logger.info(`[Ulang] ▶ ${targetUrl} | platform=${platform} | user=${message.author.id}`);

  // Invalidate cache for this URL so it re-downloads fresh
  const videoId = extractVideoId(targetUrl, platform === "Other" ? undefined : platform);
  const wasInCache = deleteCachedResult(videoId);
  logger.info(`[Ulang] Cache invalidated for ${videoId} (was cached: ${wasInCache})`);
  boomboxCache; // keep import reference used for setCachedResult below

  // ── Initial status message ────────────────────────────────────────────────
  const statusMsg = await message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xfaa61a)
      .setTitle("🔄 Membuat URL Baru...")
      .setDescription(
        `🔗 **${targetUrl.slice(0, 200)}**\n\n` +
        "Sedang memproses ulang, mohon tunggu sebentar..."
      )
      .setFooter({ text: "!ulang • BoomBox V3" })
      .setTimestamp()
    ]
  }).catch(() => null);

  if (!statusMsg) return true;

  // ── Enqueue job ───────────────────────────────────────────────────────────
  try {
    const effectivePlatform = (platform === "Other" || platform === "Spotify") ? "YouTube" : platform;

    await enqueueForPlatform(
      effectivePlatform,
      PRIORITY.FREE,
      () => _runUlangJob(message, statusMsg, targetUrl, platform, videoId),
      { jobId: `ulang-${message.author.id}-${Date.now()}` }
    );
  } catch (err) {
    logger.error(`[Ulang] Queue/job failed: ${err.message}`);
    await statusMsg.edit({
      embeds: [_failEmbed("Gagal membuat URL baru. Coba lagi nanti.")],
    }).catch(() => {});
  }

  return true;
}

// ── Job logic ─────────────────────────────────────────────────────────────────

async function _runUlangJob(message, statusMsg, url, platform, videoId) {
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boombox-ulang-"));

    const type    = BOOMBOX_CONFIG.AUDIO_TYPE    ?? "mp3";
    const quality = BOOMBOX_CONFIG.AUDIO_QUALITY ?? 128;

    // ── Download (with Kyzz fallback) ────────────────────────────────────────
    let ytResult;

    try {
      ytResult = await ytdl(url, type, String(quality));
    } catch (dlErr) {
      logger.warn(`[Ulang] yt-dlp failed (${dlErr.message}) — trying Kyzz`);
      try {
        if (platform === "YouTube" || platform === "Other" || platform === "Spotify") {
          ytResult = await kyzzYtAudio(url, quality, tmpDir);
        } else {
          ytResult = await kyzzAioDownload(url, tmpDir);
        }
      } catch (kyzzErr) {
        logger.error(`[Ulang] Kyzz also failed: ${kyzzErr.message}`);
        throw new Error(`Semua provider gagal: ${dlErr.message}`);
      }
    }

    // ── Upload ────────────────────────────────────────────────────────────────
    const t4tResult  = await top4top(ytResult.localFile);
    const boomboxUrl = t4tResult.result;

    // ── Update cache with fresh URL ───────────────────────────────────────────
    boomboxCache.setCachedResult(videoId, { boomboxUrl, ytResult });
    try {
      db.setVideoCache(videoId, {
        boomboxUrl,
        title:     ytResult.title,
        duration:  ytResult.duration,
        thumbnail: ytResult.thumbnail,
      });
    } catch {}

    // ── Success ───────────────────────────────────────────────────────────────
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("🔗 Open")
        .setURL(boomboxUrl)
        .setStyle(ButtonStyle.Link),
      new ButtonBuilder()
        .setCustomId(`bm:url:${boomboxUrl}`)
        .setLabel("📋 Copy URL")
        .setStyle(ButtonStyle.Secondary),
    );

    await statusMsg.edit({
      embeds: [new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ URL Baru Berhasil Dibuat!")
        .addFields(
          { name: "🎵 Judul",       value: (ytResult.title ?? "Unknown").slice(0, 256), inline: false },
          { name: "🔗 BoomBox URL", value: boomboxUrl.slice(0, 512),                   inline: false },
          { name: "📦 Provider",    value: ytResult.provider ?? "unknown",              inline: true  },
          { name: "🎧 Format",      value: `${type.toUpperCase()} ${quality}kbps`,      inline: true  },
        )
        .setFooter({ text: "!ulang • BoomBox V3" })
        .setTimestamp()
      ],
      components: [row],
    }).catch(() => {});

  } catch (err) {
    logger.error(`[Ulang] Job error: ${err.message}`);
    await logError({
      feature: "Ulang",
      reason:  err.message,
      stage:   "!ulang Job",
      error:   err,
    }).catch(() => {});
    await statusMsg.edit({
      embeds: [_failEmbed("Semua provider gagal. URL mungkin privat, dihapus, atau platform tidak didukung.")],
    }).catch(() => {});
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

function _failEmbed(msg) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ Gagal Membuat URL Baru")
    .setDescription(msg)
    .setTimestamp();
}
