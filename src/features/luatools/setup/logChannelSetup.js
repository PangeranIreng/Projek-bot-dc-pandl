/**
 * src/features/luatools/setup/logChannelSetup.js — Sub-panel: Setup Log Channel Lua Tools.
 *
 * Alur:
 *   [1] Tampilkan 3 tombol tool log (Obfuscator Logs / Beautify Logs / Deobfuscator Logs)
 *   [2] Pilih channel via ChannelSelectMenu
 *   [3] Tampilkan konfirmasi pending + tombol 💾 Simpan
 *   [4] Tekan Simpan → simpan ke DB
 *
 * Database tidak berubah sampai tombol Simpan ditekan.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
} from "discord.js";
import { ltDB } from "../../../database/db.js";

const COLOR  = 0x3ba4ff;
const FOOTER = "Lua Tools V1 • Setup Logs";

const TOOLS = [
  { key: "obfuscator",   emoji: "🔒", label: "Obfuscator Logs" },
  { key: "beautify",     emoji: "🧹", label: "Beautify Logs" },
  { key: "deobfuscator", emoji: "🔓", label: "Deobfuscator Logs" },
];

// ── Panel pilih tool ──────────────────────────────────────────────────────

export function buildLogToolPanel() {
  const log = ltDB.getLogChannels();

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📋 Setup Log Channel — Lua Tools")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Pilih tool untuk mengatur log channelnya.\n\n" +
      TOOLS.map(t => {
        const cur = log[t.key] ? `<#${log[t.key]}>` : "❌ Belum diatur";
        return `${t.emoji} **${t.label}**: ${cur}`;
      }).join("\n") +
      "\n\n━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder().addComponents(
    ...TOOLS.map(t =>
      new ButtonBuilder()
        .setCustomId(`ltsetup:logs:${t.key}`)
        .setLabel(t.label)
        .setEmoji(t.emoji)
        .setStyle(ButtonStyle.Primary),
    ),
    new ButtonBuilder()
      .setCustomId("ltsetup:back")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

// ── ChannelSelectMenu untuk satu log channel ──────────────────────────────

export function buildLogChannelSelectPanel(toolKey) {
  const tool = TOOLS.find(t => t.key === toolKey);
  const log  = ltDB.getLogChannels();
  const cur  = log[toolKey] ? `<#${log[toolKey]}>` : "❌ Belum diatur";

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${tool.emoji} Pilih Log Channel — ${tool.label}`)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `Channel saat ini: ${cur}\n\n` +
      `Pilih channel yang akan menerima logs untuk **${tool.label}**.\n\n` +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  const selectRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`ltsetup:logs:select:${toolKey}`)
      .setPlaceholder(`Pilih log channel ${tool.label}`)
      .addChannelTypes(ChannelType.GuildText),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ltsetup:logs")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [selectRow, backRow] };
}

// ── Handle log channel select result — tampilkan pending ──────────────────

export async function handleLogChannelSelected(interaction, toolKey) {
  const tool    = TOOLS.find(t => t.key === toolKey);
  const channel = interaction.channels.first();
  if (!channel) {
    await interaction.reply({ content: "❌ Channel tidak valid.", ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle(`${tool.emoji} ${tool.label} — Menunggu Konfirmasi`)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `📌 **Channel dipilih**: <#${channel.id}>\n\n` +
      "⚠️ **Konfigurasi belum disimpan.**\n" +
      "Tekan **💾 Simpan** untuk menyimpan ke database.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ltsetup:logs:save:${toolKey}:${channel.id}`)
      .setLabel("Simpan")
      .setEmoji("💾")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`ltsetup:logs:${toolKey}`)
      .setLabel("Pilih Ulang")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ltsetup:logs")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

// ── Handle Simpan button — commit ke DB ───────────────────────────────────

export async function handleLogChannelSave(interaction, toolKey, channelId) {
  const tool = TOOLS.find(t => t.key === toolKey);
  ltDB.setLogChannel(toolKey, channelId);

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ Log Channel Berhasil Disimpan")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `${tool.emoji} **${tool.label}** → <#${channelId}>\n\n` +
      "✅ Konfigurasi telah disimpan ke database.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ltsetup:logs")
      .setLabel("Kembali ke Setup Logs")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ltsetup:back")
      .setLabel("Menu Utama")
      .setEmoji("🏠")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}
