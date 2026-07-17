/**
 * src/features/luatools/setup/panel.js — Panel utama /setupluatools.
 *
 * Dua mode:
 *   - Belum dikonfigurasi → tampilkan wizard setup
 *   - Sudah dikonfigurasi → tampilkan ringkasan + opsi kelola
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { ltDB } from "../../../database/db.js";

const COLOR  = 0x5865f2;
const FOOTER = "Lua Tools V1 • Setup Panel";

// ── Panel: sudah dikonfigurasi ────────────────────────────────────────────

export function buildLuaToolsConfiguredPanel() {
  const ch  = ltDB.getChannels();
  const log = ltDB.getLogChannels();

  const obfCh  = ch.obfuscator   ? `<#${ch.obfuscator}>`   : "❌ Belum diatur";
  const beauCh = ch.beautify     ? `<#${ch.beautify}>`     : "❌ Belum diatur";
  const deobCh = ch.deobfuscator ? `<#${ch.deobfuscator}>` : "❌ Belum diatur";

  const obfLog  = log.obfuscator   ? `<#${log.obfuscator}>`   : "❌ Belum diatur";
  const beauLog = log.beautify     ? `<#${log.beautify}>`     : "❌ Belum diatur";
  const deobLog = log.deobfuscator ? `<#${log.deobfuscator}>` : "❌ Belum diatur";

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📜 Lua Tools — Sudah Dikonfigurasi")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Lua Tools sudah dikonfigurasi.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .addFields(
      {
        name: "📺 Channel Tools",
        value:
          `🔒 Obfuscator: ${obfCh}\n` +
          `🧹 Beautify: ${beauCh}\n` +
          `🔓 Deobfuscator: ${deobCh}`,
        inline: true,
      },
      {
        name: "📋 Channel Logs",
        value:
          `🔒 Obfuscator Logs: ${obfLog}\n` +
          `🧹 Beautify Logs: ${beauLog}\n` +
          `🔓 Deobfuscator Logs: ${deobLog}`,
        inline: true,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ltsetup:view")
      .setLabel("Lihat Konfigurasi")
      .setEmoji("📄")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ltsetup:edit")
      .setLabel("Ubah Konfigurasi")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ltsetup:delete")
      .setLabel("Hapus Setup")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ltsetup:close")
      .setLabel("Tutup")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

// ── Panel: belum dikonfigurasi / setup wizard ─────────────────────────────

export function buildLuaToolsSetupPanel() {
  const ch  = ltDB.getChannels();
  const log = ltDB.getLogChannels();

  const obfCh  = ch.obfuscator   ? `<#${ch.obfuscator}>`   : "❌ Belum diatur";
  const beauCh = ch.beautify     ? `<#${ch.beautify}>`     : "❌ Belum diatur";
  const deobCh = ch.deobfuscator ? `<#${ch.deobfuscator}>` : "❌ Belum diatur";

  const obfLog  = log.obfuscator   ? `<#${log.obfuscator}>`   : "❌ Belum diatur";
  const beauLog = log.beautify     ? `<#${log.beautify}>`     : "❌ Belum diatur";
  const deobLog = log.deobfuscator ? `<#${log.deobfuscator}>` : "❌ Belum diatur";

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📜 Lua Tools — Panel Setup")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Pilih kategori yang ingin dikonfigurasi.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .addFields(
      {
        name: "📺 Channel",
        value:
          `🔒 Obfuscator: ${obfCh}\n` +
          `🧹 Beautify: ${beauCh}\n` +
          `🔓 Deobfuscator: ${deobCh}`,
        inline: true,
      },
      {
        name: "📋 Logs",
        value:
          `🔒 Obfuscator Logs: ${obfLog}\n` +
          `🧹 Beautify Logs: ${beauLog}\n` +
          `🔓 Deobfuscator Logs: ${deobLog}`,
        inline: true,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ltsetup:channel")
      .setLabel("Setup Channel")
      .setEmoji("📺")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ltsetup:logs")
      .setLabel("Setup Logs")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Primary),
  );

  return { embed, components: [row] };
}

// ── Konfirmasi hapus ──────────────────────────────────────────────────────

export function buildDeleteConfirmPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🗑️ Hapus Setup Lua Tools")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "⚠️ Yakin ingin menghapus **seluruh konfigurasi** Lua Tools?\n\n" +
      "Semua channel dan log channel akan direset.\n" +
      "Bot tidak akan memproses file .lua sampai di-setup ulang.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ltsetup:delete:confirm")
      .setLabel("Ya, Hapus")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ltsetup:delete:cancel")
      .setLabel("Batal")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

// ── Panel "Panel ditutup" ─────────────────────────────────────────────────

export function buildClosedEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📜 Lua Tools — Setup Ditutup")
    .setDescription("Panel setup telah ditutup.")
    .setFooter({ text: FOOTER });
}
