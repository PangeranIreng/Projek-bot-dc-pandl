/**
 * bugReportEmbed.js — Embed, button, and modal builders for the Bug
 * Report & Feature Request system. Visual language matches the Ticket
 * System (same blurple panel, same footer style) per spec.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

const COLOR_PANEL   = 0x5865f2; // Blurple — same as the Ticket panel
const COLOR_BUG_LOG = 0xed4245; // Red   — "ADA BUG NIH"
const COLOR_FEATURE_LOG = 0x3498db; // Blue — "REQUEST FEATURE"
const COLOR_THANKS  = 0x57f287; // Green — ephemeral thank-you
const FOOTER_TEXT   = "Pangeran Assistant AI • Bug & Feature System";

// ── Panel ────────────────────────────────────────────────────────────────

export function buildBugPanelEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_PANEL)
    .setTitle("🐞 Bug & Feature")
    .setDescription(
      [
        "Menemukan Bug?",
        "Punya ide Feature baru?",
        "",
        "Laporkan agar Bot menjadi",
        "lebih baik dan stabil.",
      ].join("\n"),
    )
    .setFooter({ text: FOOTER_TEXT });
}

export function buildBugPanelButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bug:panel:report")
      .setLabel("Report Bug")
      .setEmoji("🐞")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("bug:panel:feature")
      .setLabel("Request Feature")
      .setEmoji("💡")
      .setStyle(ButtonStyle.Primary),
  );
}

// ── Modals ───────────────────────────────────────────────────────────────

export function buildBugReportModal() {
  return new ModalBuilder()
    .setCustomId("bug:modal:report")
    .setTitle("🐞 Report Bug")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Judul Bug")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
          .setPlaceholder("Contoh: Bot Boombox Error"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("desc")
          .setLabel("Keterangan")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true)
          .setPlaceholder("Jelaskan Bug yang ditemukan..."),
      ),
    );
}

export function buildFeatureRequestModal() {
  return new ModalBuilder()
    .setCustomId("bug:modal:feature")
    .setTitle("💡 Request Feature")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Judul Feature")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
          .setPlaceholder("Contoh: Tambah Spotify"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("desc")
          .setLabel("Keterangan")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true)
          .setPlaceholder("Jelaskan Feature yang diinginkan..."),
      ),
    );
}

// ── Log embeds (posted to logs_channel) ───────────────────────────────────

export function buildBugLogEmbed({ title, desc, userId }) {
  return new EmbedBuilder()
    .setColor(COLOR_BUG_LOG)
    .setTitle("🚨 ADA BUG NIH")
    .addFields(
      { name: "🐞 Judul", value: title, inline: false },
      { name: "📝 Keterangan", value: desc, inline: false },
      { name: "👤 Pelapor", value: `<@${userId}>`, inline: true },
      { name: "🕒 Waktu", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

export function buildFeatureLogEmbed({ title, desc, userId }) {
  return new EmbedBuilder()
    .setColor(COLOR_FEATURE_LOG)
    .setTitle("💡 REQUEST FEATURE")
    .addFields(
      { name: "✨ Judul", value: title, inline: false },
      { name: "📝 Keterangan", value: desc, inline: false },
      { name: "👤 Pengirim", value: `<@${userId}>`, inline: true },
      { name: "🕒 Waktu", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

// ── Ephemeral thank-you reply (sent to the user only) ─────────────────────

export function buildThankYouEmbed(kind) {
  const isBug = kind === "report";
  return new EmbedBuilder()
    .setColor(COLOR_THANKS)
    .setTitle(isBug ? "✅ Terima Kasih!" : "💡 Terima Kasih!")
    .setDescription(
      isBug
        ? [
            "Laporan Bug berhasil dikirim.",
            "",
            "Developer akan segera meninjau",
            "laporan yang Anda kirim.",
            "",
            "Mohon maaf atas ketidaknyamanan",
            "yang terjadi.",
            "",
            "Terima kasih telah membantu",
            "meningkatkan kualitas Bot.",
          ].join("\n")
        : [
            "Request Feature berhasil dikirim.",
            "",
            "Developer akan mempertimbangkan",
            "Feature yang Anda usulkan.",
            "",
            "Terima kasih atas masukan Anda.",
          ].join("\n"),
    );
}

export function buildDismissButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bug:dismiss")
      .setLabel("Dismiss")
      .setStyle(ButtonStyle.Secondary),
  );
}
