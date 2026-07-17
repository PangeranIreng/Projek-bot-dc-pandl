/**
 * workerstatus.js — /workerstatus slash command.
 *
 * Shows a live status snapshot of all platform workers:
 *   YouTube, TikTok, Spotify, Scanner, Obfuscator, Beautify, AI, Database
 *
 * Displays per-worker:
 *   • Status (Idle / Running / Busy / Restarting)
 *   • Active jobs / Queue depth
 *   • Max concurrency
 *   • Success / Failure / Retry / Timeout stats
 *   • RAM and CPU usage (system-wide)
 *   • Average job duration
 *
 * Access: Owner and Developer only.
 */

import os from "node:os";
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { denyIfNotStaff } from "../middleware/permissions.js";
import { getAllSnapshots } from "../features/queue/workerManager.js";

export const data = new SlashCommandBuilder()
  .setName("workerstatus")
  .setDescription("Tampilkan status semua worker dan queue (Owner/Developer only)");

/** Status label + emoji. */
function statusLabel(status) {
  switch (status) {
    case "busy":       return "🔴 Busy";
    case "running":    return "🟡 Running";
    case "restarting": return "🔄 Restarting";
    default:           return "🟢 Idle";
  }
}

/** Format ms to human-readable string. */
function fmtMs(ms) {
  if (!ms || ms <= 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

/** System memory usage as a percentage string. */
function memPercent() {
  const total = os.totalmem();
  const free  = os.freemem();
  return `${(((total - free) / total) * 100).toFixed(1)}%`;
}

/** System 1m load average relative to CPU count (as %). */
function cpuLoad() {
  const load = os.loadavg()[0];
  const cpus = os.cpus().length;
  const pct  = Math.min(100, (load / cpus) * 100);
  return `${pct.toFixed(1)}%`;
}

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  await interaction.deferReply({ ephemeral: true });

  const snapshots = getAllSnapshots();

  // Group: BoomBox platform workers vs system workers
  const BOOMBOX_WORKERS = ["youtube", "tiktok", "spotify"];
  const SYSTEM_WORKERS  = ["scanner", "obfuscator", "beautify", "ai", "database"];

  const embed = new EmbedBuilder()
    .setTitle("⚙️ Worker Status")
    .setColor(0x5865f2)
    .setTimestamp()
    .setFooter({ text: `RAM: ${memPercent()} | CPU Load: ${cpuLoad()} | ${snapshots.length} workers total` });

  // ── BoomBox Workers ──────────────────────────────────────────────────────
  const boomboxFields = snapshots
    .filter(s => BOOMBOX_WORKERS.includes(s.name))
    .map(s => ({
      name: `${workerEmoji(s.name)} ${capitalize(s.name)}`,
      value:
        `**Status:** ${statusLabel(s.status)}\n` +
        `**Active / Queue:** ${s.active} / ${s.queued}\n` +
        `**Max Concurrent:** ${s.maxConcurrent}\n` +
        `**Avg Duration:** ${fmtMs(s.avgDurationMs)}\n` +
        `**✅ Success:** ${s.stats.success}  ` +
        `**❌ Fail:** ${s.stats.failure}  ` +
        `**🔄 Retry:** ${s.stats.retries}  ` +
        `**⏱ Timeout:** ${s.stats.timeouts}`,
      inline: true,
    }));

  // ── System / Feature Workers ─────────────────────────────────────────────
  const systemFields = snapshots
    .filter(s => SYSTEM_WORKERS.includes(s.name))
    .map(s => ({
      name: `${workerEmoji(s.name)} ${capitalize(s.name)}`,
      value:
        `**Status:** ${statusLabel(s.status)}\n` +
        `**Active / Queue:** ${s.active} / ${s.queued}\n` +
        `**Max Concurrent:** ${s.maxConcurrent}\n` +
        `**✅** ${s.stats.success}  **❌** ${s.stats.failure}  **🔄** ${s.stats.retries}`,
      inline: true,
    }));

  if (boomboxFields.length > 0) {
    embed.addFields({ name: "━━ 🎵 BoomBox Workers ━━━━━━━━━━━━━━━━━━━━", value: "\u200b" });
    embed.addFields(...boomboxFields);
  }

  if (systemFields.length > 0) {
    embed.addFields({ name: "━━ 🛠 System Workers ━━━━━━━━━━━━━━━━━━━━━", value: "\u200b" });
    embed.addFields(...systemFields);
  }

  // ── Aggregate BoomBox summary ────────────────────────────────────────────
  const boomboxSnaps = snapshots.filter(s => BOOMBOX_WORKERS.includes(s.name));
  const totalActive  = boomboxSnaps.reduce((n, s) => n + s.active, 0);
  const totalQueued  = boomboxSnaps.reduce((n, s) => n + s.queued, 0);
  const totalSuccess = boomboxSnaps.reduce((n, s) => n + s.stats.success, 0);
  const totalFail    = boomboxSnaps.reduce((n, s) => n + s.stats.failure, 0);

  embed.addFields({
    name:  "━━ 📊 BoomBox Total ━━━━━━━━━━━━━━━━━━━━━",
    value: `Active: **${totalActive}** | Queued: **${totalQueued}** | Success: **${totalSuccess}** | Fail: **${totalFail}**`,
  });

  await interaction.editReply({ embeds: [embed] });
}

function workerEmoji(name) {
  const map = {
    youtube:    "🔴",
    tiktok:     "🎵",
    spotify:    "🟢",
    scanner:    "🔍",
    obfuscator: "🔒",
    beautify:   "✨",
    ai:         "🤖",
    database:   "🗄",
  };
  return map[name] ?? "⚙️";
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
