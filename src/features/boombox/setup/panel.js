/**
 * setup/panel.js — Panel utama BoomBox Setup.
 *
 * Menggunakan StringSelectMenu (dropdown) sebagai navigasi utama,
 * bukan banyak tombol.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { db }              from "../../../database/db.js";
import * as providerHealth from "../../../services/providerHealth.js";
import { getQueueSnapshot } from "../../queue/boomboxQueue.js";
import { getCacheStats }    from "../../../services/boomboxCache.js";

const COLOR  = 0x5865f2;
const FOOTER = "BoomBox • Setup";

// ── Dropdown navigasi utama ───────────────────────────────────────────────────

function _buildMenuRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("bbsetup:menu:select")
      .setPlaceholder("⚙️ Pilih opsi konfigurasi...")
      .addOptions([
        { label: "📺 Channel",           value: "channel",     description: "Atur channel BoomBox per platform" },
        { label: "📋 Logs",              value: "logs",        description: "Atur channel log BoomBox" },
        { label: "🛠️ Maintenance",       value: "maintenance", description: "Toggle maintenance per platform" },
        { label: "📊 Monitor",           value: "monitor",     description: "Lihat status provider, queue, cache, dan statistik" },
        { label: "⏱️ Batas Durasi",      value: "duration",    description: "Atur batas durasi audio per role" },
        { label: "🎨 Dashboard BoomBox", value: "dashboard",   description: "Atur tampilan embed BoomBox" },
        { label: "🗑️ Reset Konfigurasi", value: "reset",       description: "Hapus seluruh konfigurasi BoomBox" },
      ]),
  );
}

function _buildBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("setup:main")
      .setLabel("🔙 Menu Utama")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bbsetup:close")
      .setLabel("❌ Tutup")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── Panel utama ───────────────────────────────────────────────────────────────

function _buildPanelEmbed() {
  const channels      = db.getChannels();
  const maintenance   = db.getMaintenance();
  const logChannel    = db.getLogChannel();
  const platformLogCh = db.getPlatformLogChannels();

  const chYT  = channels.youtube ? `<#${channels.youtube}>` : "❌ Belum diatur";
  const chTK  = channels.tiktok  ? `<#${channels.tiktok}>`  : "❌ Belum diatur";
  const chSP  = channels.spotify ? `<#${channels.spotify}>` : "❌ Belum diatur";
  const chLog = logChannel        ? `<#${logChannel}>`       : "❌ Belum diatur";

  const chLogYT = platformLogCh.youtube ? `<#${platformLogCh.youtube}>` : "—";
  const chLogTK = platformLogCh.tiktok  ? `<#${platformLogCh.tiktok}>`  : "—";
  const chLogSP = platformLogCh.spotify ? `<#${platformLogCh.spotify}>` : "—";

  const maintYT = maintenance.youtube ? "🔴 Maintenance" : "🟢 Aktif";
  const maintTK = maintenance.tiktok  ? "🔴 Maintenance" : "🟢 Aktif";
  const maintSP = maintenance.spotify ? "🔴 Maintenance" : "🟢 Aktif";

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🎵 BoomBox — Konfigurasi")
    .addFields(
      { name: "📺 Channel",     value: `YouTube: ${chYT}\nTikTok: ${chTK}\nSpotify: ${chSP}`, inline: true },
      { name: "🛠️ Status",     value: `YouTube: ${maintYT}\nTikTok: ${maintTK}\nSpotify: ${maintSP}`, inline: true },
      { name: "📋 Global Log", value: chLog, inline: false },
      { name: "📊 Platform Log", value: `YouTube: ${chLogYT}\nTikTok: ${chLogTK}\nSpotify: ${chLogSP}`, inline: false },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildSetupBoomBoxPanel() {
  return { embed: _buildPanelEmbed(), components: [_buildMenuRow(), _buildBackRow()] };
}

export function buildConfiguredBoomBoxPanel() {
  return buildSetupBoomBoxPanel();
}

// ── Konfirmasi hapus ──────────────────────────────────────────────────────────

export function buildDeleteConfirmPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🗑️ Reset Konfigurasi BoomBox")
    .setDescription(
      "⚠️ Yakin ingin mereset **seluruh konfigurasi** BoomBox?\n\n" +
      "Semua channel, log channel, maintenance, dan role limits akan dihapus.\n" +
      "Bot tidak akan memproses BoomBox sampai di-setup ulang."
    )
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbsetup:delete:confirm").setLabel("✅ Ya, Reset").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("bbsetup:delete:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

// ── Closed ────────────────────────────────────────────────────────────────────

export function buildClosedEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🎵 BoomBox")
    .setDescription("Panel ditutup.")
    .setFooter({ text: FOOTER });
}

// ── Monitor ───────────────────────────────────────────────────────────────────

export function buildMonitorEmbed() {
  const allStatuses = providerHealth.getAllStatuses();
  const providerLines = Object.entries(allStatuses).map(([label, s]) => {
    const icon   = s.status === "ONLINE" ? "🟢" : "🔴";
    const streak = s.consecutiveFailures > 0 ? ` (${s.consecutiveFailures}x gagal)` : "";
    const skip   = s.totalSkipped > 0 ? ` | skip=${s.totalSkipped}` : "";
    return `${icon} **${label}** — ✅ ${s.totalSuccess} | ❌ ${s.totalFailure}${skip}${streak}`;
  });
  const providerSection = providerLines.length > 0 ? providerLines.join("\n") : "_Belum ada data._";

  const q = getQueueSnapshot();
  const c = getCacheStats();
  const stats = db.getStatistics();

  const byPlatformLines = Object.entries(stats.byPlatform).map(([p, n]) => `${p}: ${n}`).join("  |  ");
  const byProviderLines = Object.entries(stats.byProvider ?? {})
    .sort(([, a], [, b]) => b - a).slice(0, 6)
    .map(([p, n]) => `${p}: ${n}`).join("\n");

  const desc = [
    "**🔌 Provider**",
    providerSection,
    "",
    "**🗂️ Queue**",
    `Aktif: **${q.active}** / ${q.maxConcurrent}  |  Antrean: **${q.queued}**`,
    "",
    "**💾 Cache**",
    `Result: **${c.resultSize}**  |  Meta: **${c.metaSize}**  |  Hit Rate: **${c.hitRate}** (${c.hits}/${c.hits + c.misses})`,
    "",
    "**📈 Statistik**",
    `Total: **${stats.total}**  |  ✅ ${stats.successCount}  |  ❌ ${stats.failureCount}`,
    byPlatformLines ? `Platform: ${byPlatformLines}` : "",
    byProviderLines ? `Provider:\n${byProviderLines}` : "",
  ].filter(l => l !== "").join("\n");

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📊 BoomBox Monitor")
    .setDescription(desc.slice(0, 4096))
    .setFooter({ text: FOOTER })
    .setTimestamp();
}
