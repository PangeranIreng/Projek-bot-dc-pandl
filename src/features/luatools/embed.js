/**
 * src/features/luatools/embed.js — Semua embed builder untuk Lua Tools.
 */

import { EmbedBuilder } from "discord.js";

const COLOR_OBFUSCATOR   = 0x2f3136;
const COLOR_BEAUTIFY     = 0x5865f2;
const COLOR_DEOBFUSCATOR = 0x57f287;
const COLOR_ERROR        = 0xed4245;
const FOOTER             = "Lua Tools • Pangeran Assistant AI";

// ── Channel embeds ──────────────────────────────────────────────────────────

export function buildProcessingEmbed(tool) {
  const [emoji, label, color] = _meta(tool);
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ${label}`)
    .setDescription("━━━━━━━━━━━━━━━━━━\n\nFile sedang diproses...\n\n━━━━━━━━━━━━━━━━━━")
    .setFooter({ text: FOOTER });
}

export function buildChannelSuccessEmbed(tool) {
  const [emoji, label, color] = _meta(tool);
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ${label}`)
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "✅ **Berhasil**\n\n" +
      "📬 File telah dikirim ke DM.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

// ── DM embeds ──────────────────────────────────────────────────────────────

export function buildDmEmbed(tool, { inputFile, outputFile, duration }) {
  const [emoji, label, color] = _meta(tool);
  const fields = [
    { name: "Input",  value: `\`${inputFile}\``,  inline: true },
    { name: "Output", value: `\`${outputFile}\``, inline: true },
    { name: "Status", value: "Berhasil",          inline: true },
  ];
  if (duration !== undefined) {
    fields.push({ name: "Durasi", value: `${duration} detik`, inline: true });
  }
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ${label}`)
    .setDescription("━━━━━━━━━━━━━━━━━━")
    .addFields(fields)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

// ── Log embeds ──────────────────────────────────────────────────────────────

export function buildLogEmbed(tool, { user, inputFile, outputFile, inputSize, outputSize, duration, status = "Berhasil" }) {
  const [emoji, label, color] = _meta(tool);
  const ok = status === "Berhasil";

  const fields = [
    { name: "User",   value: `${user.tag ?? user.username}\n\`${user.id}\``, inline: true },
    { name: "Input",  value: `\`${inputFile}\``, inline: true },
    { name: "Output", value: `\`${outputFile}\``, inline: true },
  ];

  if (inputSize !== undefined && outputSize !== undefined) {
    fields.push({ name: "Ukuran", value: `${_sz(inputSize)} → ${_sz(outputSize)}`, inline: true });
  }
  if (duration !== undefined) {
    fields.push({ name: "Durasi", value: `${duration} detik`, inline: true });
  }

  const now = new Date();
  fields.push(
    { name: "Status",  value: ok ? "✅ Berhasil" : "❌ Gagal", inline: true },
    {
      name: "Tanggal",
      value: now.toLocaleDateString("id-ID", { year: "numeric", month: "long", day: "numeric" }),
      inline: true,
    },
    { name: "Jam", value: now.toLocaleTimeString("id-ID"), inline: true },
  );

  return new EmbedBuilder()
    .setColor(ok ? color : COLOR_ERROR)
    .setTitle(`${emoji} ${label}`)
    .setDescription("━━━━━━━━━━━━━━━━━━")
    .addFields(fields)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

// ── Error embeds ────────────────────────────────────────────────────────────

export function buildWrongFileTypeEmbed(ext) {
  return new EmbedBuilder()
    .setColor(COLOR_ERROR)
    .setTitle("❌ Format File Tidak Didukung")
    .setDescription(
      `File \`${ext}\` belum didukung.\n\n` +
      "Silakan gunakan source code **\`.lua\`**."
    )
    .setFooter({ text: FOOTER });
}

export function buildDmFailedEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_ERROR)
    .setTitle("❌ DM Gagal Dikirim")
    .setDescription(
      "Gagal mengirim hasil ke DM.\n\n" +
      "Aktifkan **Direct Message** lalu coba lagi."
    )
    .setFooter({ text: FOOTER });
}

export function buildProcessErrorEmbed(tool) {
  const [emoji, label] = _meta(tool);
  return new EmbedBuilder()
    .setColor(COLOR_ERROR)
    .setTitle(`${emoji} ${label} — Gagal`)
    .setDescription("Terjadi kesalahan saat memproses file. Coba lagi beberapa saat.")
    .setFooter({ text: FOOTER });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _meta(tool) {
  switch (tool) {
    case "obfuscator":   return ["🔒", "Lua Obfuscator",   COLOR_OBFUSCATOR];
    case "beautify":     return ["🧹", "Lua Beautify",     COLOR_BEAUTIFY];
    case "deobfuscator": return ["🔓", "Lua Deobfuscator", COLOR_DEOBFUSCATOR];
    default:             return ["🔧", "Lua Tools",        0x5865f2];
  }
}

function _sz(bytes) {
  if (bytes < 1024)    return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
