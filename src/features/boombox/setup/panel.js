/**
 * setup/panel.js — Panel utama /setupboombox.
 *
 * Menampilkan 4 tombol:
 *   📺 Setup Channel
 *   📋 Setup BoomBox Logs
 *   ⏱️ Batas Durasi
 *   🛠️ Maintenance
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { db } from "../../../database/db.js";

const COLOR_PANEL  = 0x5865f2;
const FOOTER_TEXT  = "BoomBox V2 • Setup Panel";

/**
 * Build the main /setupboombox panel embed + components.
 * @returns {{ embed: EmbedBuilder, components: ActionRowBuilder[] }}
 */
export function buildSetupBoomBoxPanel() {
  const channels    = db.getChannels();
  const maintenance = db.getMaintenance();
  const logChannel  = db.getLogChannel();

  const chYT = channels.youtube ? `<#${channels.youtube}>` : "❌ Belum diatur";
  const chTK = channels.tiktok  ? `<#${channels.tiktok}>` : "❌ Belum diatur";
  const chSP = channels.spotify ? `<#${channels.spotify}>` : "❌ Belum diatur";
  const chLog = logChannel       ? `<#${logChannel}>`       : "❌ Belum diatur";

  const maintYT = maintenance.youtube ? "🔴 Maintenance" : "🟢 Aktif";
  const maintTK = maintenance.tiktok  ? "🔴 Maintenance" : "🟢 Aktif";
  const maintSP = maintenance.spotify ? "🔴 Maintenance" : "🟢 Aktif";

  const embed = new EmbedBuilder()
    .setColor(COLOR_PANEL)
    .setTitle("🎵 BoomBox V2 — Panel Setup")
    .setDescription("━━━━━━━━━━━━━━━━━━\n\nPilih kategori yang ingin dikonfigurasi.\n\n━━━━━━━━━━━━━━━━━━")
    .addFields(
      {
        name: "📺 Channel",
        value: `YouTube: ${chYT}\nTikTok: ${chTK}\nSpotify: ${chSP}`,
        inline: true,
      },
      {
        name: "🛠️ Status",
        value: `YouTube: ${maintYT}\nTikTok: ${maintTK}\nSpotify: ${maintSP}`,
        inline: true,
      },
      {
        name: "📋 Log Channel",
        value: chLog,
        inline: false,
      },
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:channel")
      .setLabel("Setup Channel")
      .setEmoji("📺")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("bbsetup:logs")
      .setLabel("Setup BoomBox Logs")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("bbsetup:duration")
      .setLabel("Batas Durasi")
      .setEmoji("⏱️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bbsetup:maintenance")
      .setLabel("Maintenance")
      .setEmoji("🛠️")
      .setStyle(ButtonStyle.Danger),
  );

  return { embed, components: [row] };
}
