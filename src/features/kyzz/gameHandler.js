/**
 * gameHandler.js — Game feature via Kyzz API (game3rb).
 *
 * Endpoints:
 *   /api/game/game3rb/home
 *   /api/game/game3rb/popular
 *   /api/game/game3rb/search
 *   /api/game/game3rb/category
 *   /api/game/game3rb/detail
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { kyzzGet }  from "../../services/kyzzClient.js";
import { enqueue }  from "../queue/workerManager.js";
import { logger }   from "../../utils/logger.js";
import { logError } from "../../utils/errorLogger.js";

const TIMEOUT = 12_000;

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function handleGameCommand(interaction) {
  const sub = interaction.options.getSubcommand(true);
  await interaction.deferReply();

  try {
    await enqueue("search", () => _dispatch(interaction, sub), { priority: 3 });
  } catch (err) {
    logger.error(`[GameCmd] Queue error: ${err.message}`);
    await interaction.editReply({ embeds: [_errEmbed("Gagal memproses game command.")] }).catch(() => {});
  }
}

async function _dispatch(interaction, sub) {
  try {
    switch (sub) {
      case "home":     return await _gameHome(interaction);
      case "popular":  return await _gamePopular(interaction);
      case "search":   return await _gameSearch(interaction);
      case "category": return await _gameCategory(interaction);
      case "detail":   return await _gameDetail(interaction);
      default:
        await interaction.editReply({ content: "❌ Sub-command tidak dikenal." }).catch(() => {});
    }
  } catch (err) {
    logger.error(`[GameCmd:${sub}] ${err.message}`);
    await logError({ feature: `Game:${sub}`, reason: err.message, error: err }).catch(() => {});
    await interaction.editReply({ embeds: [_errEmbed(`Gagal: ${err.message.slice(0, 200)}`)] }).catch(() => {});
  }
}

async function _gameHome(interaction) {
  const json  = await kyzzGet("/api/game/game3rb/home", {}, { timeoutMs: TIMEOUT });
  const items = _extractList(json);

  const embed = new EmbedBuilder()
    .setColor(0x7289da)
    .setTitle("🎮 Game3rb — Home")
    .setFooter({ text: "Powered by Kyzz API • Game3rb" })
    .setTimestamp();

  _addGameFields(embed, items);
  await interaction.editReply({ embeds: [embed], components: _buildGameButtons(items) });
}

async function _gamePopular(interaction) {
  const json  = await kyzzGet("/api/game/game3rb/popular", {}, { timeoutMs: TIMEOUT });
  const items = _extractList(json);

  const embed = new EmbedBuilder()
    .setColor(0xff6b35)
    .setTitle("🔥 Game3rb — Popular Games")
    .setFooter({ text: "Powered by Kyzz API • Game3rb" })
    .setTimestamp();

  _addGameFields(embed, items);
  await interaction.editReply({ embeds: [embed], components: _buildGameButtons(items) });
}

async function _gameSearch(interaction) {
  const q    = interaction.options.getString("query", true).trim();
  const json = await kyzzGet("/api/game/game3rb/search", { query: q }, { timeoutMs: TIMEOUT });
  const items = _extractList(json);

  if (!items?.length) {
    return interaction.editReply({ embeds: [_noResult("Game", q)] });
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎮 Game3rb Search: "${q.slice(0, 80)}"`)
    .setFooter({ text: "Powered by Kyzz API • Game3rb" })
    .setTimestamp();

  _addGameFields(embed, items);
  await interaction.editReply({ embeds: [embed], components: _buildGameButtons(items) });
}

async function _gameCategory(interaction) {
  const cat  = interaction.options.getString("category") ?? "";
  const params = cat ? { category: cat } : {};
  const json = await kyzzGet("/api/game/game3rb/category", params, { timeoutMs: TIMEOUT });
  const items = _extractList(json);

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🎮 Game3rb — ${cat || "Categories"}`)
    .setFooter({ text: "Powered by Kyzz API • Game3rb" })
    .setTimestamp();

  _addGameFields(embed, items);
  await interaction.editReply({ embeds: [embed], components: _buildGameButtons(items) });
}

async function _gameDetail(interaction) {
  const q    = interaction.options.getString("game", true).trim();
  const json = await kyzzGet("/api/game/game3rb/detail", { query: q }, { timeoutMs: TIMEOUT });

  const r     = json.result ?? json.data ?? json;
  const title = r.title || r.name || q;
  const desc  = r.description || r.desc || r.content || "";
  const image = r.image || r.thumbnail || r.cover || null;
  const url   = r.url || r.link || null;
  const genre = r.genre || r.category || "";
  const size  = r.size || r.file_size || "";
  const ver   = r.version || r.ver || "";
  const rating= r.rating || r.score || "";

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`🎮 ${title.slice(0, 100)}`)
    .setDescription(desc.slice(0, 1000) || "Tidak ada deskripsi.")
    .setFooter({ text: "Powered by Kyzz API • Game3rb" })
    .setTimestamp();

  if (image) embed.setThumbnail(image);
  if (genre)  embed.addFields({ name: "Genre",   value: genre.slice(0, 100),  inline: true });
  if (size)   embed.addFields({ name: "Size",    value: size.slice(0, 50),    inline: true });
  if (ver)    embed.addFields({ name: "Version", value: ver.slice(0, 50),     inline: true });
  if (rating) embed.addFields({ name: "Rating",  value: `⭐ ${rating}`.slice(0, 50), inline: true });

  const rows = [];
  if (url && url.startsWith("http")) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("🔗 Lihat Detail").setURL(url).setStyle(ButtonStyle.Link)
    ));
  }

  await interaction.editReply({ embeds: [embed], components: rows });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _extractList(json) {
  if (Array.isArray(json.result)) return json.result;
  if (Array.isArray(json.data))   return json.data;
  if (Array.isArray(json.games))  return json.games;
  if (Array.isArray(json.list))   return json.list;
  const inner = json.result ?? json.data;
  if (inner && typeof inner === "object") {
    for (const k of ["games", "list", "items"]) {
      if (Array.isArray(inner[k])) return inner[k];
    }
  }
  return [];
}

function _addGameFields(embed, items) {
  if (!items?.length) {
    embed.setDescription("Tidak ada data.");
    return;
  }
  items.slice(0, 5).forEach((item, i) => {
    const name    = (item.title || item.name || "Unknown").slice(0, 100);
    const genre   = item.genre || item.category || "";
    const rating  = item.rating || item.score || "";
    const desc    = (item.description || item.desc || "").slice(0, 100);

    embed.addFields({
      name:  `${i + 1}. ${name}`,
      value: [genre, rating && `⭐ ${rating}`, desc].filter(Boolean).join(" • ").slice(0, 256) || "—",
    });
  });
}

function _buildGameButtons(items) {
  if (!items?.length) return [];
  return items.slice(0, 3).map(item => {
    const url = item.url || item.link || null;
    if (!url || !url.startsWith("http")) return null;
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(`🎮 ${(item.title || item.name || "Game").slice(0, 60)}`)
        .setURL(url)
        .setStyle(ButtonStyle.Link)
    );
  }).filter(Boolean);
}

function _noResult(cat, q) {
  return new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle(`🎮 ${cat}: Tidak ada hasil untuk "${q.slice(0, 80)}"`)
    .setDescription("Coba kata kunci lain.")
    .setTimestamp();
}

function _errEmbed(msg) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ Game Error")
    .setDescription(msg.slice(0, 2048))
    .setTimestamp();
}
