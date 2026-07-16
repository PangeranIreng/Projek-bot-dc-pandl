/**
 * setup/logsSetup.js — Sub-panel: Setup BoomBox Logs.
 *
 * BoomBox Logs menggunakan SATU channel.
 * Panel ini:
 *   [1] Menampilkan channel log saat ini + statistik per platform
 *   [2] Tombol ganti channel (ChannelSelectMenu)
 *   [3] Setelah channel dipilih → edit/post panel publik V2 ke channel tersebut
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
} from "discord.js";
import { db }               from "../../../database/db.js";
import { BOOMBOX_CONFIG }   from "../config.js";
import { buildPublicLogPanel } from "../logs/viewer.js";
import { logger }           from "../../../utils/logger.js";

const COLOR  = 0x3ba4ff;
const FOOTER = "BoomBox V2 • BoomBox Logs";

// ── Panel utama Logs ──────────────────────────────────────────────────────────

export function buildLogsPanel() {
  const logChannel = db.getLogChannel() ?? BOOMBOX_CONFIG.BOOMBOX_LOG_CHANNEL_ID;

  // History lama (tanpa platform) sudah ter-include di YouTube via db.getHistoryByPlatform
  const ytCount = db.getHistoryByPlatform("YouTube").length;
  const tkCount = db.getHistoryByPlatform("TikTok").length;
  const spCount = db.getHistoryByPlatform("Spotify").length;

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📋 Setup BoomBox Logs")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `📌 **Log Channel**: ${logChannel ? `<#${logChannel}>` : "❌ Belum diatur"}\n\n` +
      "**Statistik Log:**\n" +
      `🔴 YouTube: **${ytCount}** log _(termasuk log lama)_\n` +
      `⚫ TikTok: **${tkCount}** log\n` +
      `🟢 Spotify: **${spCount}** log\n\n` +
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
      .setCustomId("bbsetup:back")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2] };
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
      "Bot akan otomatis **mengedit panel BoomBox Logs lama** menjadi tampilan V2,\n" +
      "atau membuat panel baru jika belum ada.\n\n" +
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

export function buildLogChannelSavedEmbed(channelId, panelStatus = "created") {
  const statusLine =
    panelStatus === "edited"
      ? "✏️ Panel BoomBox Logs lama berhasil diperbarui ke tampilan V2."
      : "📤 Panel BoomBox Logs V2 berhasil dikirim ke channel.";

  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ Log Channel Berhasil Diatur")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `📌 **Log Channel**: <#${channelId}>\n\n` +
      `${statusLine}\n\n` +
      "Semua BoomBox Logs (YouTube, TikTok, Spotify) akan dikirim ke channel ini.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/**
 * Handle log channel select interaction.
 * Setelah channel dipilih:
 *   1. Simpan ke DB
 *   2. Edit panel lama menjadi V2, atau buat baru jika tidak ada
 *   3. Simpan messageId panel
 * @param {import("discord.js").ChannelSelectMenuInteraction} interaction
 */
export async function handleLogChannelSelected(interaction) {
  const channel = interaction.channels.first();
  if (!channel) {
    await interaction.reply({ content: "❌ Channel tidak valid.", ephemeral: true });
    return;
  }

  db.setLogChannel(channel.id);

  // ── Posting / edit panel V2 ke log channel ──────────────────────────────
  let panelStatus = "created";

  try {
    const logCh = await interaction.client.channels.fetch(channel.id).catch(() => null);
    if (logCh?.isTextBased()) {
      const state   = db.getLogState();
      const payload = buildPublicLogPanel();

      // Coba edit pesan lama (termasuk panel V1 lama)
      if (state.messageId) {
        try {
          const old = await logCh.messages.fetch(state.messageId);
          await old.edit(payload);
          panelStatus = "edited";
          logger.info(`[BoomBox] Log panel V2 berhasil diedit di #${channel.name}`);
        } catch {
          logger.info("[BoomBox] Pesan panel lama tidak ditemukan, membuat baru.");
        }
      }

      // Buat pesan baru jika panel lama tidak ada/sudah dihapus
      if (panelStatus !== "edited") {
        const newMsg = await logCh.send(payload);
        db.setLogState({ messageId: newMsg.id });
        logger.info(`[BoomBox] Panel BoomBox Logs V2 dibuat di #${channel.name}: ${newMsg.id}`);
      }
    } else {
      logger.warn(`[BoomBox] Channel ${channel.id} tidak dapat diakses atau bukan text channel`);
    }
  } catch (err) {
    logger.warn(`[BoomBox] Gagal posting panel ke log channel: ${err.message}`);
  }

  // ── Reply ke setup interaction ───────────────────────────────────────────
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
    embeds:     [buildLogChannelSavedEmbed(channel.id, panelStatus)],
    components: [backRow],
  });
}
