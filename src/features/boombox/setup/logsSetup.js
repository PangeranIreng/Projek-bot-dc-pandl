/**
 * setup/logsSetup.js — Sub-panel: Setup BoomBox Logs.
 *
 * BoomBox Logs menggunakan:
 *   - SATU global log channel (untuk log dashboard V2 publik)
 *   - PER-PLATFORM log channel (YouTube Logs, TikTok Logs, Spotify Logs)
 *     → Log detail dikirim ke channel masing-masing setelah job selesai
 *
 * Semua perubahan menggunakan tombol 💾 Simpan — database tidak berubah
 * sampai Simpan ditekan.
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

const PLATFORM_LOG_META = {
  youtube: { emoji: "📺", label: "YouTube Logs" },
  tiktok:  { emoji: "🎵", label: "TikTok Logs"  },
  spotify: { emoji: "🎧", label: "Spotify Logs"  },
};

// ── Panel utama Logs ──────────────────────────────────────────────────────────

export function buildLogsPanel() {
  const logChannel         = db.getLogChannel() ?? BOOMBOX_CONFIG.BOOMBOX_LOG_CHANNEL_ID;
  const platformLogCh      = db.getPlatformLogChannels();
  const maintenance        = db.getMaintenance();

  const platLines = Object.entries(PLATFORM_LOG_META).map(([key, { emoji, label }]) => {
    const ch = platformLogCh[key] ? `<#${platformLogCh[key]}>` : "❌ Belum diatur";
    return `${emoji} **${label}**: ${ch}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📋 Setup BoomBox Logs")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `📌 **Global Log Channel** (Dashboard V2)\n${logChannel ? `<#${logChannel}>` : "❌ Belum diatur"}\n\n` +
      "📊 **Per-Platform Log Channels** (Log detail per platform)\n" +
      platLines.join("\n") +
      "\n\n━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  // Row 1: Global log channel + maintenance toggles
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:logs:setchannel")
      .setLabel("Ganti Log Channel")
      .setEmoji("📌")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("bbsetup:logs:toggle:youtube")
      .setLabel("YouTube")
      .setEmoji("🔴")
      .setStyle(maintenance.youtube ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bbsetup:logs:toggle:tiktok")
      .setLabel("TikTok")
      .setEmoji("🎶")
      .setStyle(maintenance.tiktok ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bbsetup:logs:toggle:spotify")
      .setLabel("Spotify")
      .setEmoji("🎧")
      .setStyle(maintenance.spotify ? ButtonStyle.Danger : ButtonStyle.Secondary),
  );

  // Row 2: Per-platform log channels
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:logs:platcfg:youtube")
      .setLabel("YouTube Logs")
      .setEmoji("📺")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bbsetup:logs:platcfg:tiktok")
      .setLabel("TikTok Logs")
      .setEmoji("🎵")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bbsetup:logs:platcfg:spotify")
      .setLabel("Spotify Logs")
      .setEmoji("🎧")
      .setStyle(ButtonStyle.Secondary),
  );

  // Row 3: Utility + back
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:logs:deletepanel")
      .setLabel("Hapus Panel Lama")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("bbsetup:back")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2, row3] };
}

// ── Global Log Channel Select ─────────────────────────────────────────────────

export function buildLogChannelSelectPanel() {
  const current = db.getLogChannel() ?? BOOMBOX_CONFIG.BOOMBOX_LOG_CHANNEL_ID;

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📌 Ganti Global Log Channel")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `Channel log saat ini: ${current ? `<#${current}>` : "❌ Belum diatur"}\n\n` +
      "Pilih **satu channel** yang akan menerima **BoomBox Logs Dashboard V2** (panel publik).\n" +
      "Ini adalah panel ringkasan untuk semua platform.\n\n" +
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

export async function handleLogChannelSelected(interaction) {
  const channel = interaction.channels.first();
  if (!channel) {
    await interaction.reply({ content: "❌ Channel tidak valid.", ephemeral: true });
    return;
  }

  db.setLogChannel(channel.id);

  let panelStatus = "created";
  try {
    const logCh = await interaction.client.channels.fetch(channel.id).catch(() => null);
    if (logCh?.isTextBased()) {
      const state   = db.getLogState();
      const payload = buildPublicLogPanel();

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

      if (panelStatus !== "edited") {
        const newMsg = await logCh.send(payload);
        db.setLogState({ messageId: newMsg.id });
        logger.info(`[BoomBox] Panel BoomBox Logs V2 dibuat di #${channel.name}: ${newMsg.id}`);
      }
    }
  } catch (err) {
    logger.warn(`[BoomBox] Gagal posting panel ke log channel: ${err.message}`);
  }

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

// ── Per-Platform Log Channel Panels ──────────────────────────────────────────

export function buildPlatformLogSelectPanel(platform) {
  const { emoji, label } = PLATFORM_LOG_META[platform];
  const platformLogCh    = db.getPlatformLogChannels();
  const current          = platformLogCh[platform];

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${emoji} Setup ${label}`)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `Channel log saat ini: ${current ? `<#${current}>` : "❌ Belum diatur"}\n\n` +
      `Pilih channel yang akan menerima **log detail ${label}**.\n` +
      "Log sukses dan gagal akan dikirim ke channel ini setelah setiap job selesai.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  const selectRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`bbsetup:logs:platcfg:select:${platform}`)
      .setPlaceholder(`Pilih channel ${label}`)
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

export function buildPlatformLogPendingEmbed(platform, channelId) {
  const { emoji, label } = PLATFORM_LOG_META[platform];
  return new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle(`${emoji} ${label} — Menunggu Konfirmasi`)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `📌 **Channel dipilih**: <#${channelId}>\n\n` +
      "⚠️ **Konfigurasi belum disimpan.**\n" +
      "Tekan **💾 Simpan** untuk menyimpan ke database.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildPlatformLogSavedEmbed(platform, channelId) {
  const { emoji, label } = PLATFORM_LOG_META[platform];
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`✅ ${label} Channel Berhasil Disimpan`)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `${emoji} **Platform**: ${label}\n` +
      `📌 **Channel**: <#${channelId}>\n\n` +
      "✅ Konfigurasi telah disimpan ke database.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export async function handlePlatformLogSelected(interaction, platform) {
  const channel = interaction.channels.first();
  if (!channel) {
    await interaction.reply({ content: "❌ Channel tidak valid.", ephemeral: true });
    return;
  }

  // Tampilkan pending — database belum diubah
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bbsetup:logs:platcfg:save:${platform}:${channel.id}`)
      .setLabel("Simpan")
      .setEmoji("💾")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`bbsetup:logs:platcfg:${platform}`)
      .setLabel("Pilih Ulang")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bbsetup:logs")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.update({
    embeds:     [buildPlatformLogPendingEmbed(platform, channel.id)],
    components: [row],
  });
}

export async function handlePlatformLogSave(interaction, platform, channelId) {
  db.setPlatformLogChannel(platform, channelId);

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
    embeds:     [buildPlatformLogSavedEmbed(platform, channelId)],
    components: [backRow],
  });
}
