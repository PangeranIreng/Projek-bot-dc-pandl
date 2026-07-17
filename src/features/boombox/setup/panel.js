/**
 * setup/panel.js — Panel utama /setupboombox.
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
import { db }              from "../../../database/db.js";
import * as providerHealth from "../../../services/providerHealth.js";
import { getQueueSnapshot } from "../../queue/boomboxQueue.js";
import { getCacheStats }    from "../../../services/boomboxCache.js";

const COLOR_PANEL  = 0x5865f2;
const FOOTER_TEXT  = "BoomBox V2 • Setup Panel";

// ── Panel: Sudah Dikonfigurasi ────────────────────────────────────────────────

/**
 * Tampil saat /setupboombox dijalankan dan konfigurasi sudah ada.
 * Tombol: 📝 Edit Konfigurasi | 🗑 Hapus Konfigurasi | ❌ Tutup
 * @returns {{ embed: EmbedBuilder, components: ActionRowBuilder[] }}
 */
export function buildConfiguredBoomBoxPanel() {
  const channels         = db.getChannels();
  const maintenance      = db.getMaintenance();
  const logChannel       = db.getLogChannel();
  const platformLogCh    = db.getPlatformLogChannels();

  const chYT  = channels.youtube ? `<#${channels.youtube}>` : "❌ Belum diatur";
  const chTK  = channels.tiktok  ? `<#${channels.tiktok}>`  : "❌ Belum diatur";
  const chSP  = channels.spotify ? `<#${channels.spotify}>` : "❌ Belum diatur";
  const chLog = logChannel        ? `<#${logChannel}>`       : "❌ Belum diatur";

  const chLogYT = platformLogCh.youtube ? `<#${platformLogCh.youtube}>` : "❌ Belum diatur";
  const chLogTK = platformLogCh.tiktok  ? `<#${platformLogCh.tiktok}>`  : "❌ Belum diatur";
  const chLogSP = platformLogCh.spotify ? `<#${platformLogCh.spotify}>` : "❌ Belum diatur";

  const maintYT = maintenance.youtube ? "🔴 Maintenance" : "🟢 Aktif";
  const maintTK = maintenance.tiktok  ? "🔴 Maintenance" : "🟢 Aktif";
  const maintSP = maintenance.spotify ? "🔴 Maintenance" : "🟢 Aktif";

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ BoomBox — Sudah Dikonfigurasi")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "BoomBox sudah dikonfigurasi.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .addFields(
      {
        name:   "📺 Channel",
        value:  `YouTube: ${chYT}\nTikTok: ${chTK}\nSpotify: ${chSP}`,
        inline: true,
      },
      {
        name:   "🛠️ Status",
        value:  `YouTube: ${maintYT}\nTikTok: ${maintTK}\nSpotify: ${maintSP}`,
        inline: true,
      },
      {
        name:   "📋 Global Log Channel",
        value:  chLog,
        inline: false,
      },
      {
        name:   "📊 Platform Log Channels",
        value:  `📺 YouTube Logs: ${chLogYT}\n🎵 TikTok Logs: ${chLogTK}\n🎧 Spotify Logs: ${chLogSP}`,
        inline: false,
      },
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:edit")
      .setLabel("Edit Konfigurasi")
      .setEmoji("📝")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("bbsetup:delete")
      .setLabel("Hapus Konfigurasi")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("bbsetup:close")
      .setLabel("Tutup")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

// ── Panel: Wizard Setup (admin) ───────────────────────────────────────────────

/**
 * Build the main /setupboombox admin panel embed + components.
 * @returns {{ embed: EmbedBuilder, components: ActionRowBuilder[] }}
 */
export function buildSetupBoomBoxPanel() {
  const channels         = db.getChannels();
  const maintenance      = db.getMaintenance();
  const logChannel       = db.getLogChannel();
  const platformLogCh    = db.getPlatformLogChannels();

  const chYT  = channels.youtube ? `<#${channels.youtube}>` : "❌ Belum diatur";
  const chTK  = channels.tiktok  ? `<#${channels.tiktok}>`  : "❌ Belum diatur";
  const chSP  = channels.spotify ? `<#${channels.spotify}>` : "❌ Belum diatur";
  const chLog = logChannel        ? `<#${logChannel}>`       : "❌ Belum diatur";

  const chLogYT = platformLogCh.youtube ? `<#${platformLogCh.youtube}>` : "❌ Belum diatur";
  const chLogTK = platformLogCh.tiktok  ? `<#${platformLogCh.tiktok}>`  : "❌ Belum diatur";
  const chLogSP = platformLogCh.spotify ? `<#${platformLogCh.spotify}>` : "❌ Belum diatur";

  const maintYT = maintenance.youtube ? "🔴 Maintenance" : "🟢 Aktif";
  const maintTK = maintenance.tiktok  ? "🔴 Maintenance" : "🟢 Aktif";
  const maintSP = maintenance.spotify ? "🔴 Maintenance" : "🟢 Aktif";

  const embed = new EmbedBuilder()
    .setColor(COLOR_PANEL)
    .setTitle("🎵 BoomBox V2 — Panel Setup")
    .setDescription("━━━━━━━━━━━━━━━━━━\n\nPilih kategori yang ingin dikonfigurasi.\n\n━━━━━━━━━━━━━━━━━━")
    .addFields(
      {
        name:   "📺 Channel",
        value:  `YouTube: ${chYT}\nTikTok: ${chTK}\nSpotify: ${chSP}`,
        inline: true,
      },
      {
        name:   "🛠️ Status",
        value:  `YouTube: ${maintYT}\nTikTok: ${maintTK}\nSpotify: ${maintSP}`,
        inline: true,
      },
      {
        name:   "📋 Global Log Channel",
        value:  chLog,
        inline: false,
      },
      {
        name:   "📊 Platform Log Channels",
        value:  `📺 YouTube Logs: ${chLogYT}\n🎵 TikTok Logs: ${chLogTK}\n🎧 Spotify Logs: ${chLogSP}`,
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
    new ButtonBuilder()
      .setCustomId("bbsetup:monitor")
      .setLabel("Monitor")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

// ── Panel: Konfirmasi Hapus ───────────────────────────────────────────────────

export function buildDeleteConfirmPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🗑️ Hapus Konfigurasi BoomBox")
    .setDescription(
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "⚠️ Yakin ingin menghapus **seluruh konfigurasi** BoomBox?\n\n" +
      "Semua channel, log channel, maintenance, dan role limits akan direset.\n" +
      "Bot tidak akan memproses permintaan BoomBox sampai di-setup ulang.\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: FOOTER_TEXT });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbsetup:delete:confirm")
      .setLabel("Ya, Hapus")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("bbsetup:delete:cancel")
      .setLabel("Batal")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

// ── Panel: Closed ─────────────────────────────────────────────────────────────

export function buildClosedEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎵 BoomBox — Panel Ditutup")
    .setDescription("Panel setup telah ditutup.")
    .setFooter({ text: FOOTER_TEXT });
}

// ── Monitor ───────────────────────────────────────────────────────────────────

export function buildMonitorEmbed() {
  // ── Provider health ──────────────────────────────────────────────────────
  const allStatuses = providerHealth.getAllStatuses();
  const providerLines = Object.entries(allStatuses).map(([label, s]) => {
    const icon   = s.status === "ONLINE" ? "🟢" : "🔴";
    const streak = s.consecutiveFailures > 0 ? ` (${s.consecutiveFailures}x gagal)` : "";
    const skip   = s.totalSkipped  > 0 ? ` | skip=${s.totalSkipped}` : "";
    return `${icon} **${label}**\n   ✅ ${s.totalSuccess} | ❌ ${s.totalFailure}${skip}${streak}`;
  });
  const providerSection = providerLines.length > 0
    ? providerLines.join("\n")
    : "_Belum ada data provider._";

  // ── Queue ────────────────────────────────────────────────────────────────
  const q = getQueueSnapshot();
  const queueSection = `🔄 Aktif: **${q.active}** / ${q.maxConcurrent}  |  ⏳ Antrean: **${q.queued}**`;

  // ── Cache ────────────────────────────────────────────────────────────────
  const c = getCacheStats();
  const cacheSection =
    `💾 Result: **${c.resultSize}** entries  |  📋 Meta: **${c.metaSize}** entries\n` +
    `🎯 Hit Rate: **${c.hitRate}**  (${c.hits} hit / ${c.misses} miss)`;

  // ── Statistics ───────────────────────────────────────────────────────────
  const stats = db.getStatistics();
  const byPlatformLines = Object.entries(stats.byPlatform)
    .map(([p, n]) => `${p}: ${n}`)
    .join("  |  ");
  const byProviderLines = Object.entries(stats.byProvider ?? {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([p, n]) => `${p}: ${n}`)
    .join("\n");
  const statsSection =
    `📊 Total: **${stats.total}**  |  ✅ Sukses: **${stats.successCount}**  |  ❌ Gagal: **${stats.failureCount}**\n` +
    (byPlatformLines ? `🌍 Platform: ${byPlatformLines}\n` : "") +
    (byProviderLines ? `🔧 Provider:\n${byProviderLines}` : "");

  const SEP = "━━━━━━━━━━━━━━━━";
  const desc = [
    SEP,
    "**🔌 Provider Status**",
    "",
    providerSection,
    SEP,
    "**🗂️ Queue**",
    "",
    queueSection,
    SEP,
    "**💾 Cache**",
    "",
    cacheSection,
    SEP,
    "**📈 Statistik (sejak restart)**",
    "",
    statsSection,
    SEP,
  ].join("\n");

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📊 BoomBox Monitor")
    .setDescription(desc.slice(0, 4096))
    .setFooter({ text: "BoomBox V2 • Monitor" })
    .setTimestamp();
}
