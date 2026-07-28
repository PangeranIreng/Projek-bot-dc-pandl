/**
 * newsHandler.js — News feature via Kyzz API.
 * Endpoint: /api/news/antara
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
export async function handleNewsCommand(interaction) {
  const topic = interaction.options.getString("topic") ?? "terkini";
  await interaction.deferReply();

  try {
    await enqueue("search", () => _runNews(interaction, topic), { priority: 3 });
  } catch (err) {
    logger.error(`[NewsCmd] Queue error: ${err.message}`);
    await interaction.editReply({ embeds: [_errEmbed("Gagal memuat berita.")] }).catch(() => {});
  }
}

async function _runNews(interaction, topic) {
  logger.info(`[NewsCmd] ▶ topic=${topic} | user=${interaction.user.id}`);

  try {
    const params = topic !== "terkini" ? { topic } : {};
    const json   = await kyzzGet("/api/news/antara", params, { timeoutMs: TIMEOUT });

    const items = _extractItems(json);
    if (!items?.length) {
      return interaction.editReply({ embeds: [_noResult(topic)] });
    }

    const embed = new EmbedBuilder()
      .setColor(0xd62929)
      .setTitle(`📰 Berita ANTARA — ${topic === "terkini" ? "Terkini" : topic}`)
      .setFooter({ text: "Powered by Kyzz API • ANTARA" })
      .setTimestamp();

    const rows = [];
    items.slice(0, 5).forEach((item, i) => {
      const title = (item.title || item.judul || "Untitled").slice(0, 100);
      const date  = item.date || item.tanggal || item.publishedAt || "";
      const desc  = (item.description || item.excerpt || item.content || "").slice(0, 200);
      const url   = item.url || item.link || null;

      embed.addFields({
        name:  `${i + 1}. ${title}`,
        value: [date && `🗓️ ${date}`, desc].filter(Boolean).join("\n").slice(0, 512) || "—",
      });

      if (url && url.startsWith("http")) {
        rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel(`📰 ${title.slice(0, 60)}`)
            .setURL(url)
            .setStyle(ButtonStyle.Link)
        ));
      }
    });

    await interaction.editReply({ embeds: [embed], components: rows.slice(0, 5) });

  } catch (err) {
    logger.error(`[NewsCmd] ${err.message}`);
    await logError({ feature: "News", reason: err.message, error: err }).catch(() => {});
    await interaction.editReply({ embeds: [_errEmbed("Gagal memuat berita. Coba lagi nanti.")] }).catch(() => {});
  }
}

function _extractItems(json) {
  if (Array.isArray(json.result)) return json.result;
  if (Array.isArray(json.data))   return json.data;
  if (Array.isArray(json.news))   return json.news;
  if (Array.isArray(json.articles)) return json.articles;
  const inner = json.result ?? json.data;
  if (inner && typeof inner === "object") {
    for (const k of ["news", "articles", "items", "list"]) {
      if (Array.isArray(inner[k])) return inner[k];
    }
  }
  return null;
}

function _noResult(topic) {
  return new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle(`📰 Tidak ada berita untuk topik: "${topic}"`)
    .setDescription("Coba topik lain atau gunakan \`/news\` tanpa parameter.")
    .setTimestamp();
}

function _errEmbed(msg) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ News Error")
    .setDescription(msg.slice(0, 2048))
    .setTimestamp();
}
