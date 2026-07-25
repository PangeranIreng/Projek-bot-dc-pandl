/**
 * dashboardEmbed.js — Embed builders yang menggunakan dashboard config dari DB.
 *
 * Semua embed di-render berdasarkan pengaturan yang bisa diubah Owner via /setup.
 *
 * Fungsi-fungsi ini menggantikan buildProcessingEmbed / buildResultEmbed untuk
 * tampilan di channel publik. Embed lama di embed.js tetap ada untuk backward-compat.
 */

import { EmbedBuilder } from "discord.js";
import { db } from "../../database/db.js";

const SEP = "━━━━━━━━━━━━━━━━━━";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseColor(hex) {
  const clean = (hex ?? "#5865f2").replace("#", "");
  const n = parseInt(clean, 16);
  return isNaN(n) ? 0x5865f2 : n;
}

/**
 * Format elapsed milliseconds according to the dashboard durationFormat setting.
 * @param {number} ms
 * @param {"ms"|"s"|"minsec"|"auto"} fmt
 * @returns {string}
 */
export function formatElapsed(ms, fmt = "auto") {
  if (!ms && ms !== 0) return "—";
  switch (fmt) {
    case "ms":     return `${Math.round(ms)} ms`;
    case "s":      return `${(ms / 1000).toFixed(2)} Detik`;
    case "minsec": {
      const totalSec = Math.floor(ms / 1000);
      const min      = Math.floor(totalSec / 60);
      const sec      = totalSec % 60;
      return `${min} Menit ${sec} Detik`;
    }
    case "auto":
    default:
      if (ms < 1000)          return `${Math.round(ms)} ms`;
      if (ms < 60_000)        return `${(ms / 1000).toFixed(2)} Detik`;
      {
        const totalSec = Math.floor(ms / 1000);
        const min      = Math.floor(totalSec / 60);
        const sec      = totalSec % 60;
        return `${min} Menit ${sec} Detik`;
      }
  }
}

/**
 * Format current date/time in WIB (Asia/Jakarta, UTC+7).
 * @returns {string}
 */
function nowWIB() {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone:  "Asia/Jakarta",
    day:       "2-digit",
    month:     "long",
    year:      "numeric",
    hour:      "2-digit",
    minute:    "2-digit",
    second:    "2-digit",
    hour12:    false,
  }).format(new Date()) + " WIB";
}

/**
 * Apply GIF image to embed if showGif is enabled and URL is set.
 * @param {EmbedBuilder} embed
 * @param {object} dash   Dashboard config
 * @param {string} type   GIF type key
 */
function applyGif(embed, dash, type) {
  if (!dash.showGif) return;
  const url = dash.gifs?.[type];
  if (url) embed.setImage(url);
}

/**
 * Conditional footer.
 */
function applyFooter(embed, dash) {
  if (dash.showFooter) embed.setFooter({ text: "🎵 BoomBox" });
}

/**
 * Conditional timestamp.
 */
function applyTimestamp(embed, dash) {
  if (dash.showTimestamp) embed.setTimestamp();
}

/**
 * Build the user mention string for embed description.
 */
function mentionLine(dash, userId) {
  return dash.showMention && userId ? `<@${userId}>` : "";
}

// ── Processing Embed ──────────────────────────────────────────────────────────

/**
 * Embed saat BoomBox sedang memproses request (single embed, di-edit per tahap).
 *
 * @param {string|null} userId     Discord user ID
 * @param {string|null} stepLabel  Label tahap saat ini (null = default)
 * @param {string|null} thumbnail  Optional thumbnail URL
 * @param {object|null} dashOverride  Force a specific dash config (untuk preview)
 */
export function buildDashProcessingEmbed(userId = null, stepLabel = null, thumbnail = null, dashOverride = null) {
  const dash   = dashOverride ?? db.getDashboard();
  const color  = parseColor(dash.embedColor);
  const label  = stepLabel ?? "Sedang Memproses...";
  const mention = mentionLine(dash, userId);

  const descParts = [SEP, "", "🎵 BoomBox"];
  if (mention) descParts.push(mention);
  descParts.push("", `⏳ ${label}`, "", "Mohon tunggu sebentar.", "", SEP);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("⏳ DIPROSES")
    .setDescription(descParts.join("\n"));

  if (thumbnail && dash.showThumbnail) embed.setThumbnail(thumbnail);
  applyGif(embed, dash, "loading");
  applyFooter(embed, dash);
  // No timestamp on processing embed (it would keep updating)

  return embed;
}

// ── Success Embed ─────────────────────────────────────────────────────────────

/**
 * Embed saat proses berhasil.
 *
 * @param {object} opts
 * @param {string|null}  opts.userId
 * @param {string}       opts.title       Judul lagu
 * @param {string|null}  opts.artist      Artist / channel
 * @param {string}       opts.platform    YouTube / Spotify / TikTok
 * @param {string}       opts.boomboxUrl  Link download
 * @param {string|null}  opts.thumbnail
 * @param {number}       opts.elapsedMs   Total proses dalam ms
 * @param {boolean}      opts.fromCache   True jika hasil dari cache
 * @param {object|null}  opts.dashOverride
 */
export function buildDashSuccessEmbed(opts = {}) {
  const dash    = opts.dashOverride ?? db.getDashboard();
  const color   = parseColor(dash.embedColor);
  const mention = mentionLine(dash, opts.userId);

  const descParts = [SEP, "", "🎵 BoomBox"];
  if (mention) descParts.push(mention);
  descParts.push("", "✅ Berhasil Diproses", "", SEP);

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ BERHASIL")
    .setDescription(descParts.join("\n"));

  if (opts.title)  embed.addFields({ name: "🎵 Judul",           value: String(opts.title).slice(0, 256),  inline: false });
  if (opts.artist) embed.addFields({ name: "👤 Artist / Channel", value: String(opts.artist).slice(0, 256), inline: false });
  if (opts.platform) embed.addFields({ name: "📦 Platform",       value: opts.platform,                     inline: true  });

  // Durasi proses
  if (dash.showDuration && opts.elapsedMs != null) {
    const durLabel = opts.fromCache ? "⏱️ Waktu Pengambilan Cache" : "⏱️ Durasi Proses";
    embed.addFields({ name: durLabel, value: formatElapsed(opts.elapsedMs, dash.durationFormat), inline: true });
  }

  embed.addFields({ name: "📅 Diproses",  value: nowWIB(),      inline: false });
  embed.addFields({ name: "⬇️ Download", value: opts.boomboxUrl ?? "—", inline: false });

  if (opts.thumbnail && dash.showThumbnail) embed.setThumbnail(opts.thumbnail);

  applyGif(embed, dash, "success");
  applyFooter(embed, dash);
  applyTimestamp(embed, dash);

  return embed;
}

// ── Cache Embed ───────────────────────────────────────────────────────────────

/**
 * Embed saat hasil diambil dari cache/database.
 */
export function buildDashCacheEmbed(opts = {}) {
  const dash    = opts.dashOverride ?? db.getDashboard();
  const mention = mentionLine(dash, opts.userId);

  const descParts = [SEP, "", "🎵 BoomBox"];
  if (mention) descParts.push(mention);
  descParts.push("", "📦 File Sudah Tersedia", "", "File ditemukan di database.", "Tidak perlu diproses ulang.", "", SEP);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📦 CACHE")
    .setDescription(descParts.join("\n"));

  if (opts.title)  embed.addFields({ name: "🎵 Judul",            value: String(opts.title).slice(0, 256),  inline: false });
  if (opts.artist) embed.addFields({ name: "👤 Artist / Channel",  value: String(opts.artist).slice(0, 256), inline: false });
  if (opts.platform) embed.addFields({ name: "📦 Platform",        value: opts.platform,                     inline: true  });

  if (dash.showDuration && opts.elapsedMs != null) {
    embed.addFields({ name: "⏱️ Waktu Pengambilan Cache", value: formatElapsed(opts.elapsedMs, dash.durationFormat), inline: true });
  }

  if (opts.savedAt) embed.addFields({ name: "📅 Tersimpan",  value: String(opts.savedAt).slice(0, 100), inline: false });
  if (opts.boomboxUrl) embed.addFields({ name: "⬇️ Download", value: opts.boomboxUrl,                   inline: false });

  if (opts.thumbnail && dash.showThumbnail) embed.setThumbnail(opts.thumbnail);

  applyGif(embed, dash, "cache");
  applyFooter(embed, dash);
  applyTimestamp(embed, dash);

  return embed;
}

// ── Error Embed ───────────────────────────────────────────────────────────────

/**
 * Embed saat proses gagal.
 */
export function buildDashErrorEmbed(opts = {}) {
  const dash    = opts.dashOverride ?? db.getDashboard();
  const mention = mentionLine(dash, opts.userId);

  const descParts = [SEP, "", "🎵 BoomBox"];
  if (mention) descParts.push(mention);
  descParts.push(
    "",
    "❌ Gagal Diproses",
    "",
    "Penyebab:",
    "",
    "• Link tidak valid",
    "atau",
    "• Platform tidak didukung",
    "atau",
    "• File tidak ditemukan",
    "",
    "Silakan periksa kembali link yang dikirim.",
    "",
    SEP
  );

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ GAGAL")
    .setDescription(descParts.join("\n"));

  applyGif(embed, dash, "error");
  applyFooter(embed, dash);
  applyTimestamp(embed, dash);

  return embed;
}

// ── Maintenance Embed ─────────────────────────────────────────────────────────

/**
 * Embed saat platform sedang maintenance.
 */
export function buildDashMaintenanceEmbed(opts = {}) {
  const dash    = opts.dashOverride ?? db.getDashboard();
  const mention = mentionLine(dash, opts.userId);

  const descParts = [SEP, "", "🎵 BoomBox"];
  if (mention) descParts.push(mention);
  descParts.push(
    "",
    "🛠 BoomBox Sedang Maintenance",
    "",
    "Fitur sementara tidak dapat digunakan.",
    "Silakan tunggu hingga maintenance selesai.",
    "",
    SEP
  );

  const embed = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle("🛠 MAINTENANCE")
    .setDescription(descParts.join("\n"));

  applyGif(embed, dash, "maintenance");
  applyFooter(embed, dash);
  applyTimestamp(embed, dash);

  return embed;
}

// ── Timeout Embed ─────────────────────────────────────────────────────────────

/**
 * Embed saat proses timeout.
 */
export function buildDashTimeoutEmbed(opts = {}) {
  const dash    = opts.dashOverride ?? db.getDashboard();
  const mention = mentionLine(dash, opts.userId);

  const descParts = [SEP, "", "🎵 BoomBox"];
  if (mention) descParts.push(mention);
  descParts.push(
    "",
    "⌛ Waktu Pemrosesan Habis",
    "",
    "Server tidak memberikan respons.",
    "Silakan coba kembali nanti.",
    "",
    SEP
  );

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("⌛ TIMEOUT")
    .setDescription(descParts.join("\n"));

  applyGif(embed, dash, "timeout");
  applyFooter(embed, dash);
  applyTimestamp(embed, dash);

  return embed;
}

// ── Gangguan Embed ────────────────────────────────────────────────────────────

/**
 * Embed saat BoomBox mengalami gangguan teknis (error internal, bukan user error).
 */
export function buildDashDisruptionEmbed(opts = {}) {
  const dash    = opts.dashOverride ?? db.getDashboard();
  const mention = mentionLine(dash, opts.userId);

  const descParts = [SEP, "", "🎵 BoomBox"];
  if (mention) descParts.push(mention);
  descParts.push(
    "",
    "⚠️ BoomBox Sedang Mengalami Gangguan",
    "",
    "Layanan sedang bermasalah.",
    "Silakan coba beberapa menit lagi.",
    "",
    SEP
  );

  const embed = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle("⚠️ GANGGUAN")
    .setDescription(descParts.join("\n"));

  // Reuse error GIF for disruption, or maintenance if error not set
  const d = db.getDashboard();
  if (dash.showGif) {
    const url = d.gifs?.error || d.gifs?.maintenance;
    if (url) embed.setImage(url);
  }

  applyFooter(embed, dash);
  applyTimestamp(embed, dash);

  return embed;
}
