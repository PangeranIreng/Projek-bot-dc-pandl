/**
 * setup/maintenanceSetup.js — Sub-panel: Maintenance BoomBox.
 *
 * Toggle maintenance per platform:
 *   📺 YouTube
 *   🎵 TikTok
 *   🎧 Spotify
 *   ⚡ Semua Platform
 *
 * Saat maintenance aktif → bot membalas dengan pesan maintenance.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { db } from "../../../database/db.js";

const COLOR  = 0xed4245;
const FOOTER = "BoomBox V2 • Maintenance";

function statusEmoji(active) {
  return active ? "🔴" : "🟢";
}

function statusLabel(active) {
  return active ? "ON (Maintenance)" : "OFF (Aktif)";
}

// ── Panel Maintenance ─────────────────────────────────────────────────────────

export function buildMaintenancePanel() {
  const m = db.getMaintenance();
  const allOn = m.youtube && m.tiktok && m.spotify;

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🛠️ Maintenance BoomBox")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "Klik platform untuk toggle maintenance.\n" +
      "Saat maintenance aktif, user akan mendapat pesan:\n" +
      "> 🚧 *BoomBox sedang maintenance. Silakan coba lagi beberapa saat lagi.*\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .addFields(
      {
        name: "📺 YouTube",
        value: `${statusEmoji(m.youtube)} ${statusLabel(m.youtube)}`,
        inline: true,
      },
      {
        name: "🎵 TikTok",
        value: `${statusEmoji(m.tiktok)} ${statusLabel(m.tiktok)}`,
        inline: true,
      },
      {
        name: "🎧 Spotify",
        value: `${statusEmoji(m.spotify)} ${statusLabel(m.spotify)}`,
        inline: true,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:maint:toggle:youtube")
      .setLabel(`YouTube: ${m.youtube ? "Matikan" : "Aktifkan"}`)
      .setEmoji("📺")
      .setStyle(m.youtube ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("bbsetup:maint:toggle:tiktok")
      .setLabel(`TikTok: ${m.tiktok ? "Matikan" : "Aktifkan"}`)
      .setEmoji("🎵")
      .setStyle(m.tiktok ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("bbsetup:maint:toggle:spotify")
      .setLabel(`Spotify: ${m.spotify ? "Matikan" : "Aktifkan"}`)
      .setEmoji("🎧")
      .setStyle(m.spotify ? ButtonStyle.Success : ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:maint:toggle:all")
      .setLabel(allOn ? "Matikan Semua Platform" : "Aktifkan Maintenance Semua")
      .setEmoji("⚡")
      .setStyle(allOn ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("bbsetup:back")
      .setLabel("Kembali")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary),
  );

  return { embed, components: [row1, row2] };
}

/**
 * Handle toggle maintenance button.
 * @param {import("discord.js").ButtonInteraction} interaction
 * @param {"youtube"|"tiktok"|"spotify"|"all"} platform
 */
export async function handleMaintenanceToggle(interaction, platform) {
  if (platform === "all") {
    const m = db.getMaintenance();
    const allOn = m.youtube && m.tiktok && m.spotify;
    // If all are on → turn all off. Otherwise → turn all on.
    const newState = !allOn;
    db.setMaintenance("youtube", newState);
    db.setMaintenance("tiktok",  newState);
    db.setMaintenance("spotify", newState);
  } else {
    db.toggleMaintenance(platform);
  }

  const { embed, components } = buildMaintenancePanel();
  await interaction.update({ embeds: [embed], components });
}
