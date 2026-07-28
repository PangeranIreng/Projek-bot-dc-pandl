/**
 * imageHandler.js — Image feature via Kyzz API.
 *
 * Endpoints:
 *   /api/image/random
 *   /api/image/anime-hot
 *   /api/image/cosplay
 *   /api/image/husbu
 *   /api/image/shota
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { kyzzGet }  from "../../services/kyzzClient.js";
import { enqueue }  from "../queue/workerManager.js";
import { logger }   from "../../utils/logger.js";
import { logError } from "../../utils/errorLogger.js";

const TIMEOUT = 12_000;

const ENDPOINTS = {
  random:    { path: "/api/image/random",    label: "🎲 Random Image",    color: 0x5865f2 },
  animehot:  { path: "/api/image/anime-hot", label: "🔥 Anime Hot",       color: 0xff4f00 },
  cosplay:   { path: "/api/image/cosplay",   label: "💃 Cosplay",         color: 0xff69b4 },
  husbu:     { path: "/api/image/husbu",     label: "💙 Husbu",           color: 0x00bfff },
  shota:     { path: "/api/image/shota",     label: "✨ Shota",           color: 0x9b59b6 },
};

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function handleImageCommand(interaction) {
  const sub = interaction.options.getSubcommand(true);
  await interaction.deferReply();

  try {
    await enqueue("image", () => _runImage(interaction, sub), { priority: 3 });
  } catch (err) {
    logger.error(`[ImageCmd] Queue error: ${err.message}`);
    await interaction.editReply({ embeds: [_errEmbed("Gagal memproses request.")] }).catch(() => {});
  }
}

async function _runImage(interaction, sub) {
  const ep = ENDPOINTS[sub];
  if (!ep) {
    return interaction.editReply({ embeds: [_errEmbed("Sub-command tidak dikenal.")] });
  }

  logger.info(`[ImageCmd] ▶ ${sub} | user=${interaction.user.id}`);

  try {
    const json = await kyzzGet(ep.path, {}, { timeoutMs: TIMEOUT });

    // Extract image URL from various response shapes
    const imgUrl =
      json.result?.url   || json.result?.image || json.result?.link ||
      json.data?.url     || json.data?.image   ||
      json.url           || json.image         || json.link ||
      (typeof json.result === "string" ? json.result : null) ||
      null;

    const title =
      json.result?.title || json.title || ep.label;

    const source =
      json.result?.source || json.source || json.result?.tags || null;

    if (!imgUrl || !imgUrl.startsWith("http")) {
      throw new Error("Tidak ada URL gambar dalam respons API.");
    }

    const embed = new EmbedBuilder()
      .setColor(ep.color)
      .setTitle(ep.label)
      .setImage(imgUrl)
      .setFooter({ text: "Powered by Kyzz API" })
      .setTimestamp();

    if (source) embed.setDescription(`🏷️ ${String(source).slice(0, 100)}`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("🔗 Open Full Size")
        .setURL(imgUrl)
        .setStyle(ButtonStyle.Link)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });

  } catch (err) {
    logger.error(`[ImageCmd:${sub}] ${err.message}`);
    await logError({ feature: `Image:${sub}`, reason: err.message, error: err }).catch(() => {});
    await interaction.editReply({
      embeds: [_errEmbed(`Gagal mengambil gambar: ${err.message.slice(0, 200)}`)],
    }).catch(() => {});
  }
}

function _errEmbed(msg) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ Image Error")
    .setDescription(msg.slice(0, 2048))
    .setTimestamp();
}
