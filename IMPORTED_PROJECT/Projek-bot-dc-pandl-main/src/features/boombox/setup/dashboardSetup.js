/**
 * dashboardSetup.js — Dashboard BoomBox Setup Panel.
 *
 * Semua pengaturan tampilan dashboard dapat diubah oleh Owner tanpa mengedit kode.
 *
 * CustomId prefix: bbdash:
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

const FOOTER = "BoomBox • Dashboard";
const COLOR  = 0x5865f2;

// ── Helpers ───────────────────────────────────────────────────────────────────

function on(v) { return v ? "🟢 Aktif" : "🔴 Nonaktif"; }
function bullet(v) { return v ? "✅" : "❌"; }

function parseColor(hex) {
  const clean = (hex ?? "#5865f2").replace("#", "");
  const n = parseInt(clean, 16);
  return isNaN(n) ? 0x5865f2 : n;
}

const GIF_TYPES = ["loading", "success", "cache", "error", "maintenance", "timeout"];
const GIF_LABELS = {
  loading:     "⏳ Loading",
  success:     "✅ Sukses",
  cache:       "📦 Cache",
  error:       "❌ Error",
  maintenance: "🛠 Maintenance",
  timeout:     "⌛ Timeout",
};

const DUR_FORMAT_LABELS = {
  ms:      "Milidetik (ms)",
  s:       "Detik (s)",
  minsec:  "Menit & Detik",
  auto:    "Otomatis",
};

// ── Main Panel ────────────────────────────────────────────────────────────────

export function buildDashboardMainPanel() {
  const d = db.getDashboard();

  const embed = new EmbedBuilder()
    .setColor(parseColor(d.embedColor))
    .setTitle("🎨 Dashboard BoomBox")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Atur tampilan embed BoomBox sesuai keinginan.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .addFields(
      {
        name: "⚙️ Pengaturan Umum",
        value:
          `${bullet(d.enabled)} Dashboard\n` +
          `${bullet(d.showStatus)} Status Proses\n` +
          `${bullet(d.showMention)} Mention User`,
        inline: true,
      },
      {
        name: "🖼 Tampilan",
        value:
          `${bullet(d.showThumbnail)} Thumbnail\n` +
          `${bullet(d.showFooter)} Footer\n` +
          `${bullet(d.showTimestamp)} Timestamp`,
        inline: true,
      },
      {
        name: "⏱️ Durasi",
        value:
          `${bullet(d.showDuration)} Tampilkan Durasi\n` +
          `📐 Format: **${DUR_FORMAT_LABELS[d.durationFormat] ?? "Otomatis"}**`,
        inline: true,
      },
      {
        name: "🎬 GIF",
        value: `${bullet(d.showGif)} GIF Aktif`,
        inline: true,
      },
      {
        name: "🎨 Warna Embed",
        value: `\`${d.embedColor}\``,
        inline: true,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const menuRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("bbdash:menu:select")
      .setPlaceholder("⚙️ Pilih pengaturan dashboard...")
      .addOptions([
        { label: "⚙️ Toggle Pengaturan",  value: "toggles",   description: "Aktifkan / nonaktifkan fitur dashboard" },
        { label: "🎬 Pengaturan GIF",     value: "gif",        description: "Atur URL GIF per status" },
        { label: "🎨 Warna Embed",        value: "color",      description: "Ubah warna embed" },
        { label: "⏱️ Durasi Proses",      value: "duration",   description: "Atur tampilan durasi proses" },
        { label: "👁 Preview Dashboard",  value: "preview",    description: "Lihat preview tampilan embed" },
        { label: "🔄 Reset Dashboard",    value: "reset",      description: "Reset semua pengaturan ke default" },
      ]),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbsetup:back").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("bbsetup:close").setLabel("❌ Tutup").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [menuRow, backRow] };
}

// ── Toggle Panel ──────────────────────────────────────────────────────────────

export function buildDashboardTogglePanel() {
  const d = db.getDashboard();

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🎨 Dashboard — Toggle Pengaturan")
    .setDescription("Klik tombol untuk mengaktifkan / menonaktifkan pengaturan.")
    .addFields(
      {
        name: "Status Saat Ini",
        value:
          `${bullet(d.enabled)} **Dashboard** — tampilan embed aktif\n` +
          `${bullet(d.showStatus)} **Status Proses** — tampilkan update selama proses\n` +
          `${bullet(d.showGif)} **GIF** — tampilkan animasi GIF\n` +
          `${bullet(d.showThumbnail)} **Thumbnail** — gambar kecil di pojok embed\n` +
          `${bullet(d.showFooter)} **Footer** — teks footer embed\n` +
          `${bullet(d.showTimestamp)} **Timestamp** — waktu di footer\n` +
          `${bullet(d.showMention)} **Mention User** — @mention di embed`,
      },
    )
    .setFooter({ text: FOOTER });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:toggle:enabled").setLabel(d.enabled ? "❌ Nonaktifkan Dashboard" : "✅ Aktifkan Dashboard").setStyle(d.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("bbdash:toggle:showStatus").setLabel(d.showStatus ? "❌ Nonaktifkan Status" : "✅ Aktifkan Status").setStyle(d.showStatus ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("bbdash:toggle:showGif").setLabel(d.showGif ? "❌ Nonaktifkan GIF" : "✅ Aktifkan GIF").setStyle(d.showGif ? ButtonStyle.Danger : ButtonStyle.Success),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:toggle:showThumbnail").setLabel(d.showThumbnail ? "❌ Nonaktifkan Thumbnail" : "✅ Aktifkan Thumbnail").setStyle(d.showThumbnail ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("bbdash:toggle:showFooter").setLabel(d.showFooter ? "❌ Nonaktifkan Footer" : "✅ Aktifkan Footer").setStyle(d.showFooter ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("bbdash:toggle:showTimestamp").setLabel(d.showTimestamp ? "❌ Nonaktifkan Timestamp" : "✅ Aktifkan Timestamp").setStyle(d.showTimestamp ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("bbdash:toggle:showMention").setLabel(d.showMention ? "❌ Nonaktifkan Mention" : "✅ Aktifkan Mention").setStyle(d.showMention ? ButtonStyle.Danger : ButtonStyle.Success),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:menu").setLabel("🔙 Kembali ke Dashboard").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2, backRow] };
}

// ── GIF Panel ─────────────────────────────────────────────────────────────────

export function buildDashboardGifPanel() {
  const d = db.getDashboard();

  const gifLines = GIF_TYPES.map(type => {
    const url = d.gifs[type];
    const label = GIF_LABELS[type];
    return url ? `${label}: ✅ Diatur` : `${label}: —`;
  }).join("\n");

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🎬 Dashboard — Pengaturan GIF")
    .setDescription(
      `GIF saat ini: ${on(d.showGif)}\n\n` +
      "Klik tombol untuk mengatur URL GIF.\n" +
      "Kosongkan URL untuk menghapus GIF tersebut.\n\n" +
      gifLines
    )
    .setFooter({ text: FOOTER });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:gif:set:loading").setLabel("⏳ Loading").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bbdash:gif:set:success").setLabel("✅ Sukses").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bbdash:gif:set:cache").setLabel("📦 Cache").setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:gif:set:error").setLabel("❌ Error").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bbdash:gif:set:maintenance").setLabel("🛠 Maintenance").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bbdash:gif:set:timeout").setLabel("⌛ Timeout").setStyle(ButtonStyle.Primary),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:menu").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2, backRow] };
}

export function buildGifModal(type) {
  const d = db.getDashboard();
  const modal = new ModalBuilder()
    .setCustomId(`bbdash:gif:modal:${type}`)
    .setTitle(`URL GIF — ${GIF_LABELS[type]}`);

  const input = new TextInputBuilder()
    .setCustomId("gif_url")
    .setLabel("URL GIF (kosongkan untuk menghapus)")
    .setStyle(TextInputStyle.Short)
    .setValue(d.gifs[type] ?? "")
    .setRequired(false)
    .setPlaceholder("https://media.giphy.com/...");

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ── Color Panel ───────────────────────────────────────────────────────────────

export function buildColorModal() {
  const d = db.getDashboard();
  const modal = new ModalBuilder()
    .setCustomId("bbdash:color:modal")
    .setTitle("Ubah Warna Embed");

  const input = new TextInputBuilder()
    .setCustomId("embed_color")
    .setLabel("Warna Hex (contoh: #5865f2 atau FF0000)")
    .setStyle(TextInputStyle.Short)
    .setValue(d.embedColor ?? "#5865f2")
    .setRequired(true)
    .setMinLength(3)
    .setMaxLength(7)
    .setPlaceholder("#5865f2");

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ── Duration Panel ────────────────────────────────────────────────────────────

export function buildDashboardDurationPanel() {
  const d = db.getDashboard();

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("⏱️ Dashboard — Durasi Proses")
    .setDescription(
      "Tampilkan berapa lama waktu yang dibutuhkan untuk memproses sebuah request.\n\n" +
      `Status: ${on(d.showDuration)}\n` +
      `Format: **${DUR_FORMAT_LABELS[d.durationFormat] ?? "Otomatis"}**`
    )
    .addFields({
      name: "Format Tersedia",
      value:
        "• **Milidetik (ms)** — `850 ms`\n" +
        "• **Detik (s)** — `0.85 Detik`\n" +
        "• **Menit & Detik** — `0 Menit 0 Detik`\n" +
        "• **Otomatis** — pilih format terbaik secara otomatis",
    })
    .setFooter({ text: FOOTER });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbdash:toggle:showDuration")
      .setLabel(d.showDuration ? "❌ Nonaktifkan Durasi" : "✅ Aktifkan Durasi")
      .setStyle(d.showDuration ? ButtonStyle.Danger : ButtonStyle.Success),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:dur:format:ms").setLabel("ms").setStyle(d.durationFormat === "ms" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("bbdash:dur:format:s").setLabel("Detik").setStyle(d.durationFormat === "s" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("bbdash:dur:format:minsec").setLabel("Menit & Detik").setStyle(d.durationFormat === "minsec" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("bbdash:dur:format:auto").setLabel("Otomatis").setStyle(d.durationFormat === "auto" ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:menu").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2, backRow] };
}

// ── Preview Panel ─────────────────────────────────────────────────────────────

export function buildPreviewPanel() {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("👁 Preview Dashboard")
    .setDescription("Pilih embed mana yang ingin di-preview.")
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:preview:processing").setLabel("⏳ Processing").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bbdash:preview:success").setLabel("✅ Sukses").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("bbdash:preview:cache").setLabel("📦 Cache").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("bbdash:preview:error").setLabel("❌ Error").setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:preview:maintenance").setLabel("🛠 Maintenance").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("bbdash:preview:timeout").setLabel("⌛ Timeout").setStyle(ButtonStyle.Secondary),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:menu").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row, row2, backRow] };
}

// ── Reset Panel ───────────────────────────────────────────────────────────────

export function buildDashboardResetConfirmPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🔄 Reset Dashboard")
    .setDescription(
      "⚠️ Yakin ingin mereset **seluruh pengaturan dashboard** ke default?\n\n" +
      "Semua URL GIF, warna, dan toggle akan dikembalikan ke pengaturan awal."
    )
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbdash:reset:confirm").setLabel("✅ Ya, Reset").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("bbdash:menu").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}
