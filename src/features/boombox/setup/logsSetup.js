/**
 * setup/logsSetup.js — Sub-panel: Setup BoomBox Logs.
 *
 * BoomBox Logs menggunakan SATU channel.
 * Panel ini:
 *   [1] Menampilkan channel log saat ini
 *   [2] Tombol untuk ganti channel (ChannelSelectMenu)
 *   [3] Tombol untuk membuka Log Viewer per platform
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
} from "discord.js";
import { db } from "../../../database/db.js";
import { BOOMBOX_CONFIG } from "../config.js";

const COLOR  = 0x3ba4ff;
const FOOTER = "BoomBox V2 • BoomBox Logs";

// ── Panel utama Logs ──────────────────────────────────────────────────────────

export function buildLogsPanel() {
  const logChannel = db.getLogChannel() ?? BOOMBOX_CONFIG.BOOMBOX_LOG_CHANNEL_ID;
  const history    = db.getHistoryByPlatform(null);
  const ytCount    = history.filter(e => e.platform === "YouTube").length;
  const tkCount    = history.filter(e => e.platform === "TikTok").length;
  const spCount    = history.filter(e => e.platform === "Spotify").length;

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📋 Setup BoomBox Logs")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `📌 **Log Channel**: ${logChannel ? `<#${logChannel}>` : "❌ Belum diatur"}\n\n` +
      "**Statistik Log:**\n" +
      `📺 YouTube: **${ytCount}** log\n` +
      `🎵 TikTok: **${tkCount}** log\n` +
      `🎧 Spotify: **${spCount}** log\n\n` +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:logs:setchannel")
      .setLabel("Ganti Log Channel")
      .setEmoji("📌")
      .setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bblog:v:platform:YouTube")
      .setLabel("Logs YouTube")
      .setEmoji("📺")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bblog:v:platform:TikTok")
      .setLabel("Logs TikTok")
      .setEmoji("🎵")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bblog:v:platform:Spotify")
      .setLabel("Logs Spotify")
      .setEmoji("🎧")
      .setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:back")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
  );

  return { embed, components: [row1, row2, row3] };
}

// ── Pilih channel log ─────────────────────────────────────────────────────────

export function buildLogChannelSelectPanel() {
  const current = db.getLogChannel() ?? BOOMBOX_CONFIG.BOOMBOX_LOG_CHANNEL_ID;

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📌 Ganti Log Channel")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `Channel log saat ini: ${current ? `<#${current}>` : "❌ Belum diatur"}\n\n` +
      "Pilih **satu channel** yang akan menerima semua BoomBox Logs.\n" +
      "Semua platform (YouTube, TikTok, Spotify) dikirim ke channel yang sama.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  const selectRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("bbsetup:logs:channel:select")
      .setPlaceholder("Pilih channel log BoomBox")
      .addChannelTypes(ChannelType.GuildText),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:logs")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
  );

  return { embed, components: [selectRow, backRow] };
}

// ── Konfirmasi simpan log channel ─────────────────────────────────────────────

export function buildLogChannelSavedEmbed(channelId) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ Log Channel Berhasil Diatur")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `📌 **Log Channel**: <#${channelId}>\n\n` +
      "Semua BoomBox Logs (YouTube, TikTok, Spotify) akan dikirim ke channel ini.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/**
 * Handle log channel select interaction.
 * @param {import("discord.js").ChannelSelectMenuInteraction} interaction
 */
export async function handleLogChannelSelected(interaction) {
  const channel = interaction.channels.first();
  if (!channel) {
    await interaction.reply({ content: "❌ Channel tidak valid.", ephemeral: true });
    return;
  }

  db.setLogChannel(channel.id);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:logs")
      .setLabel("Kembali ke Setup Logs")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("bbsetup:back")
      .setLabel("Menu Utama")
      .setEmoji("🏠")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    embeds:     [buildLogChannelSavedEmbed(channel.id)],
    components: [backRow],
  });
}
