/**
 * setup/channelSetup.js — Sub-panel: Setup Channel per platform.
 *
 * Alur:
 *   [1] Tampilkan 3 tombol platform (YouTube / TikTok / Spotify)
 *   [2] Owner memilih platform
 *   [3] Tampilkan ChannelSelectMenu
 *   [4] Owner memilih channel
 *   [5] Simpan ke DB → tampilkan konfirmasi + tombol Kembali
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

const COLOR  = 0x5865f2;
const FOOTER = "BoomBox V2 • Setup Channel";

const PLATFORM_LABELS = {
  youtube: { emoji: "📺", label: "YouTube" },
  tiktok:  { emoji: "🎵", label: "TikTok"  },
  spotify: { emoji: "🎧", label: "Spotify" },
};

// ── Step 1: Pilih Platform ────────────────────────────────────────────────────

export function buildChannelPlatformPanel() {
  const channels = db.getChannels();

  const lines = Object.entries(PLATFORM_LABELS).map(([key, { emoji, label }]) => {
    const ch = channels[key] ? `<#${channels[key]}>` : "❌ Belum diatur";
    return `${emoji} **${label}**: ${ch}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📺 Setup Channel")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Pilih platform yang ingin dikonfigurasi channelnya.\n\n" +
      lines.join("\n") + "\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:channel:youtube")
      .setLabel("YouTube")
      .setEmoji("📺")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bbsetup:channel:tiktok")
      .setLabel("TikTok")
      .setEmoji("🎵")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bbsetup:channel:spotify")
      .setLabel("Spotify")
      .setEmoji("🎧")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bbsetup:back")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
  );

  return { embed, components: [row] };
}

// ── Step 2: Pilih Channel ─────────────────────────────────────────────────────

export function buildChannelSelectPanel(platform) {
  const { emoji, label } = PLATFORM_LABELS[platform];
  const current = db.getChannels()[platform];

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${emoji} Setup Channel — ${label}`)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `Channel saat ini: ${current ? `<#${current}>` : "❌ Belum diatur"}\n\n` +
      `Pilih channel Discord yang akan menjadi channel **BoomBox ${label}**.\n\n` +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  const selectRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`bbsetup:channel:select:${platform}`)
      .setPlaceholder(`Pilih channel untuk ${label}`)
      .addChannelTypes(ChannelType.GuildText),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:channel")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
  );

  return { embed, components: [selectRow, backRow] };
}

// ── Step 3: Konfirmasi ────────────────────────────────────────────────────────

export function buildChannelSavedEmbed(platform, channelId) {
  const { emoji, label } = PLATFORM_LABELS[platform];

  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`✅ Channel ${label} Berhasil Diatur`)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `${emoji} **Platform**: ${label}\n` +
      `📌 **Channel**: <#${channelId}>\n\n` +
      "Channel berhasil disimpan ke database.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/**
 * Handle channel select interaction.
 * @param {import("discord.js").ChannelSelectMenuInteraction} interaction
 * @param {string} platform — "youtube" | "tiktok" | "spotify"
 */
export async function handleChannelSelected(interaction, platform) {
  const channel = interaction.channels.first();
  if (!channel) {
    await interaction.reply({ content: "❌ Channel tidak valid.", ephemeral: true });
    return;
  }

  db.setChannel(platform, channel.id);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:channel")
      .setLabel("Kembali ke Setup Channel")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("bbsetup:back")
      .setLabel("Menu Utama")
      .setEmoji("🏠")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    embeds:     [buildChannelSavedEmbed(platform, channel.id)],
    components: [backRow],
  });
}
