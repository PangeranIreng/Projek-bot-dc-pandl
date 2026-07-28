/**
 * searchHandler.js — Search features via Kyzz API.
 *
 * Endpoints:
 *   /api/search/yts           — YouTube search
 *   /api/search/iq-search     — Drama, Anime, Film
 *   /api/search/prompt-search — AI Prompt search
 *   /api/search/sekolah       — School resources
 *   /api/search/server-discord— Discord server search
 *   /api/search/sticker-pack  — WhatsApp sticker packs
 *   /api/search/uptodown      — Android apps
 *   /api/search/wa-group      — WhatsApp groups
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { kyzzGet }  from "../../services/kyzzClient.js";
import { enqueue }  from "../queue/workerManager.js";
import { logger }   from "../../utils/logger.js";
import { logError } from "../../utils/errorLogger.js";

const TIMEOUT = 15_000;

// ── Sub-command router ────────────────────────────────────────────────────────

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function handleSearchCommand(interaction) {
  const sub = interaction.options.getSubcommand(true);
  await interaction.deferReply();

  try {
    await enqueue("search", () => _dispatch(interaction, sub), { priority: 3 });
  } catch (err) {
    logger.error(`[SearchCmd] Queue error: ${err.message}`);
    await interaction.editReply({ embeds: [_errEmbed("Gagal memproses pencarian.")] }).catch(() => {});
  }
}

async function _dispatch(interaction, sub) {
  const q = interaction.options.getString("query", true).trim();
  try {
    switch (sub) {
      case "youtube":  return await _searchYoutube(interaction, q);
      case "anime":    return await _searchIq(interaction, q);
      case "prompt":   return await _searchPrompt(interaction, q);
      case "sekolah":  return await _searchSekolah(interaction, q);
      case "discord":  return await _searchDiscord(interaction, q);
      case "sticker":  return await _searchSticker(interaction, q);
      case "app":      return await _searchUptodown(interaction, q);
      case "wagroup":  return await _searchWaGroup(interaction, q);
      default:
        await interaction.editReply({ content: "❌ Sub-command tidak dikenal." }).catch(() => {});
    }
  } catch (err) {
    logger.error(`[SearchCmd:${sub}] ${err.message}`);
    await logError({ feature: `Search:${sub}`, reason: err.message, error: err }).catch(() => {});
    await interaction.editReply({ embeds: [_errEmbed(`Pencarian gagal: ${_safeMsg(err)}`)] }).catch(() => {});
  }
}

// ── YouTube search ────────────────────────────────────────────────────────────

async function _searchYoutube(interaction, q) {
  const json  = await kyzzGet("/api/search/yts", { query: q }, { timeoutMs: TIMEOUT });
  const items = _extract(json, ["results", "data", "videos"]);

  if (!items?.length) {
    return interaction.editReply({ embeds: [_noResult("YouTube", q)] });
  }

  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle(`🔴 YouTube Search: "${q.slice(0, 80)}"`)
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  const rows = [];
  items.slice(0, 5).forEach((item, i) => {
    const title    = item.title || item.name || "Unknown";
    const videoId  = item.id || item.videoId || item.video_id || "";
    const url      = item.url || item.link || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
    const duration = item.duration || item.length || "";
    const views    = item.views ? `👁 ${item.views}` : "";
    const uploader = item.channel || item.uploader || item.author || "";

    embed.addFields({
      name:  `${i + 1}. ${title.slice(0, 100)}`,
      value: [duration && `⏱ ${duration}`, views, uploader && `📺 ${uploader}`].filter(Boolean).join(" • ").slice(0, 256) || "—",
    });

    if (url) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(`▶️ ${(i + 1)}. ${title.slice(0, 60)}`).setURL(url).setStyle(ButtonStyle.Link)
      ));
    }
  });

  await interaction.editReply({ embeds: [embed], components: rows.slice(0, 5) });
}

// ── IQ search (anime/drama/film) ──────────────────────────────────────────────

async function _searchIq(interaction, q) {
  const json  = await kyzzGet("/api/search/iq-search", { query: q }, { timeoutMs: TIMEOUT });
  const items = _extract(json, ["results", "data", "list"]);

  if (!items?.length) return interaction.editReply({ embeds: [_noResult("Drama/Anime/Film", q)] });

  const embed = new EmbedBuilder()
    .setColor(0xe91e8c)
    .setTitle(`🎬 Anime/Drama/Film: "${q.slice(0, 80)}"`)
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  const rows = [];
  items.slice(0, 5).forEach((item, i) => {
    const title = item.title || item.name || "Unknown";
    const url   = item.url || item.link || item.id || null;
    const genre = item.genre || item.category || "";
    const year  = item.year || item.release || "";
    const score = item.score || item.rating || "";

    embed.addFields({
      name:  `${i + 1}. ${title.slice(0, 100)}`,
      value: [genre, year, score && `⭐ ${score}`].filter(Boolean).join(" • ").slice(0, 256) || "—",
    });

    if (url && url.startsWith("http")) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(`🎬 ${title.slice(0, 60)}`).setURL(url).setStyle(ButtonStyle.Link)
      ));
    }
  });

  await interaction.editReply({ embeds: [embed], components: rows.slice(0, 5) });
}

// ── Prompt AI search ──────────────────────────────────────────────────────────

async function _searchPrompt(interaction, q) {
  const json = await kyzzGet("/api/search/prompt-search", { query: q }, { timeoutMs: TIMEOUT });
  const text = json.result || json.data || json.text || json.response || JSON.stringify(json).slice(0, 1000);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🤖 Prompt Search: "${q.slice(0, 80)}"`)
    .setDescription(String(text).slice(0, 2048))
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── School resources ──────────────────────────────────────────────────────────

async function _searchSekolah(interaction, q) {
  const json  = await kyzzGet("/api/search/sekolah", { query: q }, { timeoutMs: TIMEOUT });
  const items = _extract(json, ["results", "data", "list"]);

  if (!items?.length) {
    const text = json.result || json.text || json.answer || null;
    if (text) {
      const embed = new EmbedBuilder()
        .setColor(0x00b0f4)
        .setTitle(`📚 Sekolah: "${q.slice(0, 80)}"`)
        .setDescription(String(text).slice(0, 2048))
        .setFooter({ text: "Powered by Kyzz API" })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }
    return interaction.editReply({ embeds: [_noResult("Sekolah", q)] });
  }

  const embed = new EmbedBuilder()
    .setColor(0x00b0f4)
    .setTitle(`📚 Sekolah: "${q.slice(0, 80)}"`)
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  items.slice(0, 5).forEach((item, i) => {
    embed.addFields({
      name:  `${i + 1}. ${(item.title || item.name || "Item").slice(0, 100)}`,
      value: (item.description || item.content || item.text || "—").slice(0, 256),
    });
  });

  await interaction.editReply({ embeds: [embed] });
}

// ── Discord server search ─────────────────────────────────────────────────────

async function _searchDiscord(interaction, q) {
  const json  = await kyzzGet("/api/search/server-discord", { query: q }, { timeoutMs: TIMEOUT });
  const items = _extract(json, ["results", "data", "servers"]);

  if (!items?.length) return interaction.editReply({ embeds: [_noResult("Discord Server", q)] });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`💬 Discord Server: "${q.slice(0, 80)}"`)
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  const rows = [];
  items.slice(0, 5).forEach((item, i) => {
    const name    = item.name || item.title || "Unknown";
    const invite  = item.invite || item.url || item.link || null;
    const members = item.members || item.member_count || "";
    const desc    = item.description || "";

    embed.addFields({
      name:  `${i + 1}. ${name.slice(0, 100)}`,
      value: [members && `👥 ${members}`, desc.slice(0, 100)].filter(Boolean).join(" • ") || "—",
    });

    if (invite && invite.startsWith("http")) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(`🔗 Join: ${name.slice(0, 60)}`).setURL(invite).setStyle(ButtonStyle.Link)
      ));
    }
  });

  await interaction.editReply({ embeds: [embed], components: rows.slice(0, 5) });
}

// ── WhatsApp sticker pack search ──────────────────────────────────────────────

async function _searchSticker(interaction, q) {
  const json  = await kyzzGet("/api/search/sticker-pack", { query: q }, { timeoutMs: TIMEOUT });
  const items = _extract(json, ["results", "data", "packs", "stickers"]);

  if (!items?.length) return interaction.editReply({ embeds: [_noResult("Sticker Pack", q)] });

  const embed = new EmbedBuilder()
    .setColor(0x25d366)
    .setTitle(`🎨 WhatsApp Sticker Pack: "${q.slice(0, 80)}"`)
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  const rows = [];
  items.slice(0, 5).forEach((item, i) => {
    const name  = item.name || item.title || "Unknown";
    const count = item.count || item.sticker_count || "";
    const url   = item.url || item.link || item.download || null;

    embed.addFields({
      name:  `${i + 1}. ${name.slice(0, 100)}`,
      value: count ? `🗂 ${count} stickers` : "—",
    });

    if (url && url.startsWith("http")) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(`⬇️ Download: ${name.slice(0, 60)}`).setURL(url).setStyle(ButtonStyle.Link)
      ));
    }
  });

  await interaction.editReply({ embeds: [embed], components: rows.slice(0, 5) });
}

// ── Uptodown app search ───────────────────────────────────────────────────────

async function _searchUptodown(interaction, q) {
  const json  = await kyzzGet("/api/search/uptodown", { query: q }, { timeoutMs: TIMEOUT });
  const items = _extract(json, ["results", "data", "apps"]);

  if (!items?.length) return interaction.editReply({ embeds: [_noResult("Uptodown App", q)] });

  const embed = new EmbedBuilder()
    .setColor(0x00a68c)
    .setTitle(`📱 App Search: "${q.slice(0, 80)}"`)
    .setFooter({ text: "Powered by Kyzz API • Uptodown" })
    .setTimestamp();

  const rows = [];
  items.slice(0, 5).forEach((item, i) => {
    const name    = item.name || item.title || "Unknown";
    const version = item.version || "";
    const rating  = item.rating || item.score || "";
    const url     = item.url || item.link || null;

    embed.addFields({
      name:  `${i + 1}. ${name.slice(0, 100)}`,
      value: [version && `v${version}`, rating && `⭐ ${rating}`].filter(Boolean).join(" • ") || "—",
    });

    if (url && url.startsWith("http")) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(`📥 ${name.slice(0, 60)}`).setURL(url).setStyle(ButtonStyle.Link)
      ));
    }
  });

  await interaction.editReply({ embeds: [embed], components: rows.slice(0, 5) });
}

// ── WhatsApp group search ─────────────────────────────────────────────────────

async function _searchWaGroup(interaction, q) {
  const json  = await kyzzGet("/api/search/wa-group", { query: q }, { timeoutMs: TIMEOUT });
  const items = _extract(json, ["results", "data", "groups"]);

  if (!items?.length) return interaction.editReply({ embeds: [_noResult("WhatsApp Group", q)] });

  const embed = new EmbedBuilder()
    .setColor(0x25d366)
    .setTitle(`💚 WA Group: "${q.slice(0, 80)}"`)
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  const rows = [];
  items.slice(0, 5).forEach((item, i) => {
    const name    = item.name || item.title || "Unknown";
    const members = item.members || item.member_count || "";
    const link    = item.link || item.url || item.invite || null;
    const desc    = item.description || "";

    embed.addFields({
      name:  `${i + 1}. ${name.slice(0, 100)}`,
      value: [members && `👥 ${members}`, desc.slice(0, 100)].filter(Boolean).join(" • ") || "—",
    });

    if (link && link.startsWith("http")) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(`🔗 Join: ${name.slice(0, 60)}`).setURL(link).setStyle(ButtonStyle.Link)
      ));
    }
  });

  await interaction.editReply({ embeds: [embed], components: rows.slice(0, 5) });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _extract(json, keys) {
  for (const k of keys) {
    if (Array.isArray(json[k]) && json[k].length > 0) return json[k];
  }
  // Sometimes nested under result/data
  const inner = json.result ?? json.data;
  if (inner) {
    for (const k of keys) {
      if (Array.isArray(inner[k]) && inner[k].length > 0) return inner[k];
    }
    if (Array.isArray(inner)) return inner;
  }
  return null;
}

function _safeMsg(err) {
  const msg = err?.message ?? String(err);
  // Strip any potential API key from error messages
  return msg.replace(/apikey=[^\s&]*/gi, "apikey=***").slice(0, 200);
}

function _noResult(category, q) {
  return new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle(`🔍 ${category}: Tidak ada hasil untuk "${q.slice(0, 80)}"`)
    .setDescription("Coba kata kunci yang berbeda.")
    .setTimestamp();
}

function _errEmbed(msg) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ Search Error")
    .setDescription(msg.slice(0, 2048))
    .setTimestamp();
}
