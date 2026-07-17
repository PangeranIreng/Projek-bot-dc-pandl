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
import { db }              from "../../../database/db.js";
import * as providerHealth from "../../../services/providerHealth.js";
import { getQueueSnapshot } from "../../queue/boomboxQueue.js";
import { getCacheStats }    from "../../../services/boomboxCache.js";

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
    new ButtonBuilder()
      .setCustomId("bbsetup:monitor")
      .setLabel("Monitor")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

/**
 * Build the BoomBox monitoring embed.
 * Shows provider health, queue, cache, and statistics — all in one panel.
 * @returns {EmbedBuilder}
 */
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
