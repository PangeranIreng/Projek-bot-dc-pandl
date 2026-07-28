/**
 * downloadHandler.js — Universal download command via Kyzz AIO + Instagram endpoints.
 *
 * Handles /download slash command.
 * Supports: YouTube, TikTok, Instagram, Facebook, Twitter/X, Threads,
 *           Pinterest, MediaFire, dan platform lain yang didukung Kyzz.
 */

import fs   from "node:fs";
import path from "node:path";
import os   from "node:os";
import {
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { kyzzGet }           from "../../services/kyzzClient.js";
import { enqueue }           from "../queue/workerManager.js";
import { logger }            from "../../utils/logger.js";
import { logError }          from "../../utils/errorLogger.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;

// ── Platform detection ────────────────────────────────────────────────────────

const PLATFORM_PATTERNS = [
  { name: "Instagram", regex: /instagram\.com\//i },
  { name: "TikTok",    regex: /tiktok\.com\//i },
  { name: "Twitter/X", regex: /(twitter\.com|x\.com)\//i },
  { name: "Facebook",  regex: /facebook\.com\//i },
  { name: "YouTube",   regex: /youtu(\.be|be\.com)\//i },
  { name: "Threads",   regex: /threads\.net\//i },
  { name: "Pinterest", regex: /pinterest\.(com|co\.id)\//i },
  { name: "MediaFire", regex: /mediafire\.com\//i },
  { name: "SoundCloud",regex: /soundcloud\.com\//i },
];

function detectPlatform(url) {
  for (const p of PLATFORM_PATTERNS) {
    if (p.regex.test(url)) return p.name;
  }
  return "Unknown";
}

// ── Response parsers ──────────────────────────────────────────────────────────

function parseAioResponse(json) {
  const ok =
    json.status === true || json.status === "ok" || json.status === "success" ||
    json.success === true;

  // Handle array of media items
  let items = [];
  if (Array.isArray(json.result)) items = json.result;
  else if (Array.isArray(json.data))   items = json.data;
  else if (Array.isArray(json.medias)) items = json.medias;

  if (items.length > 0) {
    return {
      title:     json.title || items[0].title || "Media",
      thumbnail: json.thumbnail || items[0].thumbnail || null,
      uploader:  json.uploader || json.author || null,
      items: items.map(item => ({
        quality: item.quality || item.type || item.resolution || "default",
        url:     item.url || item.download_url || item.src || item.link,
        ext:     item.ext || item.format || "mp4",
      })).filter(i => i.url && i.url.startsWith("http")),
    };
  }

  // Flat structure fallback
  const url =
    json.result?.download_url || json.result?.url || json.result?.link ||
    json.data?.url || json.url || json.download_url || json.link || null;

  if (!url) throw new Error(json.message || json.error || "No download URL in response");

  return {
    title:     json.title || json.result?.title || "Media",
    thumbnail: json.thumbnail || json.result?.thumbnail || null,
    uploader:  json.uploader || json.author || null,
    items: [{ quality: "default", url, ext: "mp4" }],
  };
}

function parseMediaFireResponse(json) {
  const r = json.result ?? json.data ?? json;
  const url = r.download_url || r.direct_link || r.url || json.url || null;
  if (!url) throw new Error(json.message || "No MediaFire download URL");
  return {
    title:    r.filename || r.name || json.filename || "File",
    fileSize: r.file_size || r.size || json.file_size || null,
    url,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function handleDownloadCommand(interaction) {
  const url      = interaction.options.getString("url", true).trim();
  const platform = detectPlatform(url);

  await interaction.deferReply();

  try {
    await enqueue("download",
      () => _runDownload(interaction, url, platform),
      { priority: 3 }
    );
  } catch (err) {
    logger.error(`[DownloadCmd] Queue error: ${err.message}`);
    await interaction.editReply({
      embeds: [_errorEmbed("Gagal memproses request.", err.message)],
    }).catch(() => {});
  }
}

async function _runDownload(interaction, url, platform) {
  logger.info(`[DownloadCmd] ▶ ${platform} | ${url} | user=${interaction.user.id}`);

  try {
    let result;

    if (platform === "MediaFire") {
      result = await _handleMediaFire(url);
    } else if (platform === "Instagram") {
      result = await _handleInstagram(url);
    } else {
      result = await _handleAio(url);
    }

    await _sendResult(interaction, url, platform, result);

  } catch (err) {
    logger.error(`[DownloadCmd] Error: ${err.message}`);
    await logError({
      feature: "Download Command",
      reason:  err.message,
      stage:   "Download",
      error:   err,
    }).catch(() => {});

    await interaction.editReply({
      embeds: [_errorEmbed(
        "❌ Gagal mengunduh.",
        "Link tidak didukung, privat, atau provider sedang tidak tersedia. Coba lagi nanti."
      )],
    }).catch(() => {});
  }
}

async function _handleAio(url) {
  const json = await kyzzGet("/api/download/aio", { url }, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  return parseAioResponse(json);
}

async function _handleInstagram(url) {
  // Instagram endpoint has priority over AIO
  let json;
  try {
    json = await kyzzGet("/api/download/instagram", { url }, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  } catch {
    json = await kyzzGet("/api/download/aio", { url }, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  }
  return parseAioResponse(json);
}

async function _handleMediaFire(url) {
  const json = await kyzzGet("/api/download/mediafire", { url }, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const mf   = parseMediaFireResponse(json);
  return {
    title:     mf.title,
    thumbnail: null,
    uploader:  null,
    items: [{
      quality: mf.fileSize ? `${mf.fileSize}` : "File",
      url:     mf.url,
      ext:     path.extname(mf.title || "file").slice(1) || "bin",
    }],
  };
}

async function _sendResult(interaction, url, platform, result) {
  const { title, thumbnail, uploader, items } = result;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title?.slice(0, 256) || "Download Result")
    .setDescription(`📦 Platform: **${platform}**`)
    .setFooter({ text: "Kyzz Downloader • Universal Download" })
    .setTimestamp();

  if (thumbnail) embed.setThumbnail(thumbnail);
  if (uploader)  embed.addFields({ name: "Uploader", value: uploader.slice(0, 100), inline: true });

  embed.addFields({
    name:   `Media (${items.length} item${items.length > 1 ? "s" : ""})`,
    value:  items.slice(0, 5).map((item, i) =>
      `\`${i + 1}.\` [${item.quality || item.ext}](${item.url})`
    ).join("\n").slice(0, 1024),
  });

  // Build link buttons for first 5 items
  const rows = [];
  const btnItems = items.slice(0, 5);
  for (let i = 0; i < btnItems.length; i += 3) {
    const chunk = btnItems.slice(i, i + 3);
    if (chunk.length > 0) {
      const row = new ActionRowBuilder().addComponents(
        ...chunk.map((item, idx) =>
          new ButtonBuilder()
            .setLabel(`⬇️ ${item.quality || item.ext || `Item ${i + idx + 1}`}`.slice(0, 80))
            .setURL(item.url)
            .setStyle(ButtonStyle.Link)
        )
      );
      rows.push(row);
    }
  }

  await interaction.editReply({
    embeds:     [embed],
    components: rows.slice(0, 5),
  });
}

function _errorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(title)
    .setDescription(description?.slice(0, 2048) || "Terjadi kesalahan.")
    .setTimestamp();
}
