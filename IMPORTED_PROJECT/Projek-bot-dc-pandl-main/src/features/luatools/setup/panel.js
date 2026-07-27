/**
 * src/features/luatools/setup/panel.js — Panel utama Lua Tools Setup.
 *
 * Menggunakan StringSelectMenu (dropdown) sebagai navigasi, bukan banyak tombol.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { ltDB } from "../../../database/db.js";

const COLOR  = 0x5865f2;
const FOOTER = "Lua Tools • Setup";

// ── Dropdown navigasi ─────────────────────────────────────────────────────────

function _buildMenuRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ltsetup:menu:select")
      .setPlaceholder("⚙️ Pilih opsi konfigurasi...")
      .addOptions([
        { label: "📺 Channel",           value: "channel", description: "Atur channel Obfuscator, Beautify, Deobfuscator" },
        { label: "📋 Logs",              value: "logs",    description: "Atur channel log per tool" },
        { label: "🗑️ Reset Konfigurasi", value: "reset",  description: "Hapus seluruh konfigurasi Lua Tools" },
      ]),
  );
}

function _buildBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("setup:main")
      .setLabel("🔙 Menu Utama")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ltsetup:close")
      .setLabel("❌ Tutup")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── Panel utama ───────────────────────────────────────────────────────────────

function _buildPanelEmbed() {
  const ch  = ltDB.getChannels();
  const log = ltDB.getLogChannels();

  const obfCh  = ch.obfuscator   ? `<#${ch.obfuscator}>`   : "❌ Belum diatur";
  const beauCh = ch.beautify     ? `<#${ch.beautify}>`     : "❌ Belum diatur";
  const deobCh = ch.deobfuscator ? `<#${ch.deobfuscator}>` : "❌ Belum diatur";

  const obfLog  = log.obfuscator   ? `<#${log.obfuscator}>`   : "—";
  const beauLog = log.beautify     ? `<#${log.beautify}>`     : "—";
  const deobLog = log.deobfuscator ? `<#${log.deobfuscator}>` : "—";

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📜 Lua Tools — Konfigurasi")
    .addFields(
      {
        name:  "📺 Channel",
        value: `🔒 Obfuscator: ${obfCh}\n🧹 Beautify: ${beauCh}\n🔓 Deobfuscator: ${deobCh}`,
        inline: true,
      },
      {
        name:  "📋 Logs",
        value: `🔒 Obfuscator: ${obfLog}\n🧹 Beautify: ${beauLog}\n🔓 Deobfuscator: ${deobLog}`,
        inline: true,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildLuaToolsSetupPanel() {
  return { embed: _buildPanelEmbed(), components: [_buildMenuRow(), _buildBackRow()] };
}

export function buildLuaToolsConfiguredPanel() {
  return buildLuaToolsSetupPanel();
}

// ── Konfirmasi hapus ──────────────────────────────────────────────────────────

export function buildDeleteConfirmPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🗑️ Reset Konfigurasi Lua Tools")
    .setDescription(
      "⚠️ Yakin ingin mereset **seluruh konfigurasi** Lua Tools?\n\n" +
      "Semua channel dan log channel akan dihapus.\n" +
      "Bot tidak akan memproses file .lua sampai di-setup ulang."
    )
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ltsetup:delete:confirm").setLabel("✅ Ya, Reset").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ltsetup:delete:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

// ── Closed ────────────────────────────────────────────────────────────────────

export function buildClosedEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📜 Lua Tools")
    .setDescription("Panel ditutup.")
    .setFooter({ text: FOOTER });
}
