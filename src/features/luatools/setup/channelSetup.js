/**
 * src/features/luatools/setup/channelSetup.js — Sub-panel: Setup Channel Lua Tools.
 *
 * Alur:
 *   [1] Tampilkan 3 tombol tool (Obfuscator / Beautify / Deobfuscator)
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

const COLOR  = 0x5865f2;
const FOOTER = "Lua Tools V1 • Setup Channel";

const TOOLS = [
  { key: "obfuscator",   emoji: "🔒", label: "Obfuscator" },
  { key: "beautify",     emoji: "🧹", label: "Beautify" },
  { key: "deobfuscator", emoji: "🔓", label: "Deobfuscator" },
];

// ── Panel pilih tool ──────────────────────────────────────────────────────

export function buildChannelToolPanel() {
  const ch = ltDB.getChannels();

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📺 Setup Channel — Lua Tools")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Pilih tool untuk mengatur channelnya.\n\n" +
      TOOLS.map(t => {
        const cur = ch[t.key] ? `<#${ch[t.key]}>` : "❌ Belum diatur";
        return `${t.emoji} **${t.label}**: ${cur}`;
      }).join("\n") +
      "\n\n━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder().addComponents(
    ...TOOLS.map(t =>
      new ButtonBuilder()
        .setCustomId(`ltsetup:channel:${t.key}`)
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

// ── ChannelSelectMenu untuk satu tool ────────────────────────────────────

export function buildChannelSelectPanel(toolKey) {
  const tool = TOOLS.find(t => t.key === toolKey);
  const ch   = ltDB.getChannels();
  const cur  = ch[toolKey] ? `<#${ch[toolKey]}>` : "❌ Belum diatur";

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${tool.emoji} Pilih Channel — ${tool.label}`)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `Channel saat ini: ${cur}\n\n` +
      `Pilih channel yang akan menerima file .lua untuk **${tool.label}**.\n\n` +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  const selectRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`ltsetup:channel:select:${toolKey}`)
      .setPlaceholder(`Pilih channel ${tool.label}`)
      .addChannelTypes(ChannelType.GuildText),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ltsetup:channel")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [selectRow, backRow] };
}

// ── Handle channel select result — tampilkan pending, bukan langsung simpan ──

export async function handleChannelSelected(interaction, toolKey) {
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
      .setCustomId(`ltsetup:channel:save:${toolKey}:${channel.id}`)
      .setLabel("Simpan")
      .setEmoji("💾")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`ltsetup:channel:${toolKey}`)
      .setLabel("Pilih Ulang")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ltsetup:channel")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

// ── Handle Simpan button — commit ke DB ───────────────────────────────────

export async function handleChannelSave(interaction, toolKey, channelId) {
  const tool = TOOLS.find(t => t.key === toolKey);
  ltDB.setChannel(toolKey, channelId);

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ Channel Berhasil Disimpan")
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
      .setCustomId("ltsetup:channel")
      .setLabel("Kembali ke Setup Channel")
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
