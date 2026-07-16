/**
 * setup/durationSetup.js — Sub-panel: Batas Durasi per Role.
 *
 * Alur:
 *   [1] Tampilkan semua role server (baca langsung dari Discord API)
 *   [2] Owner memilih role dari StringSelectMenu (dropdown)
 *   [3] Tampilkan input: pilih durasi (menit) via tombol preset atau modal
 *   [4] Simpan ke DB → { "<roleId>": <minutes> }
 *   [5] Konfirmasi
 *
 * Nama role TIDAK disimpan ke database — selalu diambil dari Discord real-time.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { db } from "../../../database/db.js";

const COLOR  = 0xfaa61a;
const FOOTER = "BoomBox V2 • Batas Durasi";

// Preset durasi (menit) yang umum dipakai
const DURATION_PRESETS = [5, 10, 15, 20, 25, 30, 45, 60];

// ── Panel Utama Batas Durasi ──────────────────────────────────────────────────

export async function buildDurationPanel(guild) {
  const roleLimits = db.getRoleLimits();
  const guildRoles = await guild.roles.fetch();

  // Filter: skip @everyone dan bot roles, sort by position descending
  const relevantRoles = guildRoles
    .filter(r => !r.managed && r.id !== guild.id)
    .sort((a, b) => b.position - a.position);

  const lines = [];
  for (const [id, role] of relevantRoles) {
    const limitMin = roleLimits[id];
    const limitStr = limitMin != null ? `**${limitMin} menit**` : "_default (25 menit)_";
    lines.push(`${role.name}: ${limitStr}`);
  }

  const descBody = lines.length > 0
    ? lines.slice(0, 15).join("\n") + (lines.length > 15 ? `\n... dan ${lines.length - 15} role lainnya` : "")
    : "_Tidak ada role._";

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("⏱️ Batas Durasi per Role")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Atur durasi video maksimal untuk setiap role.\n" +
      "Role tanpa pengaturan menggunakan **default 25 menit**.\n\n" +
      "**Role & Batas Durasi:**\n" +
      descBody + "\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  // Build select menu — max 25 options per Discord limit
  const options = [...relevantRoles.values()].slice(0, 25).map(role => {
    const lim = roleLimits[role.id];
    return {
      label: role.name.slice(0, 25),
      value: role.id,
      description: lim != null ? `Saat ini: ${lim} menit` : "Saat ini: default (25 menit)",
    };
  });

  const components = [];

  if (options.length > 0) {
    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("bbsetup:dur:rolesel")
        .setPlaceholder("Pilih role untuk diatur durasi...")
        .addOptions(options),
    );
    components.push(selectRow);
  }

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:back")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
  );
  components.push(backRow);

  return { embed, components };
}

// ── Panel set durasi untuk role terpilih ─────────────────────────────────────

export function buildDurationSetPanel(role) {
  const current = db.getRoleLimits()[role.id];

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`⏱️ Atur Durasi — ${role.name}`)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `Role: **${role.name}**\n` +
      `Durasi saat ini: ${current != null ? `**${current} menit**` : "_default (25 menit)_"}\n\n` +
      "Pilih durasi maksimal atau klik **Custom** untuk input manual.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER });

  // Preset buttons — 4 per row, max 2 rows = 8 presets
  const presetOptions = DURATION_PRESETS.map(min =>
    new ButtonBuilder()
      .setCustomId(`bbsetup:dur:set:${role.id}:${min}`)
      .setLabel(`${min} menit`)
      .setStyle(ButtonStyle.Secondary),
  );

  const row1 = new ActionRowBuilder().addComponents(...presetOptions.slice(0, 4));
  const row2 = new ActionRowBuilder().addComponents(...presetOptions.slice(4, 8));

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bbsetup:dur:custom:${role.id}`)
      .setLabel("Custom Durasi")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`bbsetup:dur:reset:${role.id}`)
      .setLabel("Reset ke Default")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("bbsetup:duration")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
  );

  return { embed, components: [row1, row2, row3] };
}

// ── Modal untuk custom durasi ─────────────────────────────────────────────────

export function buildDurationModal(roleId) {
  const modal = new ModalBuilder()
    .setCustomId(`bbsetup:dur:modal:${roleId}`)
    .setTitle("Custom Batas Durasi");

  const input = new TextInputBuilder()
    .setCustomId("dur_minutes")
    .setLabel("Durasi Maksimal (menit)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Contoh: 45")
    .setMinLength(1)
    .setMaxLength(4)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ── Konfirmasi simpan ─────────────────────────────────────────────────────────

export function buildDurationSavedEmbed(roleName, minutes) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ Batas Durasi Berhasil Diatur")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `🎭 **Role**: ${roleName}\n` +
      `⏱️ **Durasi Maksimal**: ${minutes} menit\n\n` +
      "Tersimpan ke database.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildDurationResetEmbed(roleName) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("🔄 Batas Durasi Direset")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      `🎭 **Role**: ${roleName}\n` +
      "Kembali ke default: **25 menit**.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}
