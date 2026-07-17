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

export function buildProcessErrorEmbed(tool, reason) {
  const [emoji, label] = _meta(tool);
  // Show actual reason so the user knows what went wrong (API offline, timeout, invalid key, etc.)
  const desc = reason
    ? `**❌ Gagal memproses file**\n\n**Alasan:** ${reason}`
    : "❌ Terjadi kesalahan saat memproses file. Coba lagi beberapa saat.";
  return new EmbedBuilder()
    .setColor(COLOR_ERROR)
    .setTitle(`${emoji} ${label} — Gagal`)
    .setDescription(desc)
    .setFooter({ text: FOOTER });
}

export function buildErrorLogEmbed(tool, { user, guild, channel, fileName, fileSize, reason, httpStatus, apiResponse, stack }) {
  const [emoji, label] = _meta(tool);
  const now = new Date();
  const fields = [
    { name: "Feature",   value: `${emoji} ${label}`, inline: true },
    { name: "User",      value: user ? `${user.tag ?? user.username}\n\`${user.id}\`` : "Unknown", inline: true },
    { name: "Guild",     value: guild ?? "Unknown", inline: true },
    { name: "Channel",   value: channel ? `<#${channel}>` : "Unknown", inline: true },
    { name: "File",      value: fileName ? `\`${fileName}\`` : "Unknown", inline: true },
    { name: "Ukuran",    value: fileSize ? _sz(fileSize) : "Unknown", inline: true },
    { name: "Alasan",    value: (reason ?? "Unknown").slice(0, 512), inline: false },
  ];
  if (httpStatus) fields.push({ name: "HTTP Status", value: String(httpStatus), inline: true });
  if (apiResponse) fields.push({ name: "API Response", value: apiResponse.slice(0, 512), inline: false });
  if (stack) fields.push({ name: "Stack", value: `\`\`\`\n${stack.slice(0, 500)}\n\`\`\``, inline: false });
  fields.push(
    { name: "Tanggal", value: now.toLocaleDateString("id-ID", { year: "numeric", month: "long", day: "numeric" }), inline: true },
    { name: "Jam",     value: now.toLocaleTimeString("id-ID"), inline: true },
  );
  return new EmbedBuilder()
    .setColor(COLOR_ERROR)
    .setTitle(`❌ Error Log — ${label}`)
    .setDescription("━━━━━━━━━━━━━━━━━━")
    .addFields(fields)
    .setFooter({ text: FOOTER })
    .setTimestamp();
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
