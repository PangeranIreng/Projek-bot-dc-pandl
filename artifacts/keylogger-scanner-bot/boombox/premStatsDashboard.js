/**
 * premStatsDashboard.js — Premium Statistics Dashboard.
 *
 * Modern replacement for the old "👑 Premium Monitoring" panel.
 * Channel is chosen by the /premstats command and stored in premDB.
 * One message, always edited — never spammed.
 *
 * Auto-updated by: /addprem, /removeprem, /setlimit, /resetlimit,
 * premium expiration sweep, and bot restart.
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { premDB, db } from "./db.js";
import { logger } from "../utils/logger.js";

const SEP      = "━━━━━━━━━━━━━━━━";
const MAX_LIST = 20; // max entries per section to avoid embed size overflow

// ── Time helpers ──────────────────────────────────────────────────────────

/**
 * Format ms-until-expiry into multiline Indonesian:
 *   "2 Hari\n5 Jam\n20 Menit"
 * Returns null for permanent (caller shows ♾️ Permanen).
 */
function formatSisa(expiresAt) {
  if (!expiresAt) return null; // permanent

  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "Berakhir";

  const totalSec = Math.floor(ms / 1000);
  const days  = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins  = Math.floor((totalSec % 3600)  / 60);

  const parts = [];
  if (days  > 0) parts.push(`${days} Hari`);
  if (hours > 0) parts.push(`${hours} Jam`);
  if (mins  > 0 || parts.length === 0) parts.push(`${mins} Menit`);
  return parts.join("\n");
}

/** Current time in WIB (UTC+7). */
function formatWIB() {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 3_600_000);
  const d   = String(wib.getUTCDate()).padStart(2, "0");
  const mo  = wib.getUTCMonth();
  const y   = wib.getUTCFullYear();
  const h   = String(wib.getUTCHours()).padStart(2, "0");
  const mi  = String(wib.getUTCMinutes()).padStart(2, "0");
  const s   = String(wib.getUTCSeconds()).padStart(2, "0");
  const MONTHS = ["Januari","Februari","Maret","April","Mei","Juni",
                  "Juli","Agustus","September","Oktober","November","Desember"];
  return { date: `${d} ${MONTHS[mo]} ${y}`, time: `${h}:${mi}:${s} WIB` };
}

// ── Stats ─────────────────────────────────────────────────────────────────

function calcStats() {
  const now = new Date();

  const premUsers = premDB.getAllPremiumUsers().filter(u =>
    !u.expiresAt || new Date(u.expiresAt) > now
  );
  const premRoles = premDB.getAllPremiumRoles().filter(r =>
    !r.expiresAt || new Date(r.expiresAt) > now
  );
  const limUsers = premDB.getAllCustomLimitUsers().filter(u =>
    premDB.getCustomLimitUser(u.userId) !== null
  );
  const limRoles = premDB.getAllCustomLimitRoles().filter(r =>
    premDB.getCustomLimitRole(r.roleId) !== null
  );

  return { premUsers, premRoles, limUsers, limRoles };
}

// ── Embed builder ─────────────────────────────────────────────────────────

export function buildPremStatsEmbed() {
  const { premUsers, premRoles, limUsers, limRoles } = calcStats();
  const wib = formatWIB();

  const allPrem  = [...premUsers, ...premRoles];
  const allLim   = [...limUsers,  ...limRoles];
  const permPrem = allPrem.filter(r => r.type === "permanent").length;
  const tempPrem = allPrem.filter(r => r.type === "temporary").length;

  // ── Section: Ringkasan ───────────────────────────────────────────────
  const summaryLines = [
    `📊 **Ringkasan**`,
    ``,
    `👑 Premium Aktif : **${allPrem.length}**`,
    `💎 Premium Permanen : **${permPrem}**`,
    `⏳ Premium Sementara : **${tempPrem}**`,
    `🎵 Limit Kustom : **${allLim.length}**`,
  ];

  // ── Section: Pengguna Premium ────────────────────────────────────────
  const premEntries = [];
  for (const u of premUsers.slice(0, MAX_LIST)) {
    const sisa = formatSisa(u.expiresAt);
    const sisaBlock = sisa === null
      ? `♾️ Permanen`
      : `⏳ Sisa :\n${sisa}`;
    premEntries.push(`👤 <@${u.userId}>\n\n👑 Premium\n\n${sisaBlock}`);
  }
  for (const r of premRoles.slice(0, MAX_LIST - premEntries.length)) {
    const sisa = formatSisa(r.expiresAt);
    const sisaBlock = sisa === null
      ? `♾️ Permanen`
      : `⏳ Sisa :\n${sisa}`;
    premEntries.push(`👤 <@&${r.roleId}>\n\n👑 Premium\n\n${sisaBlock}`);
  }
  if (allPrem.length > MAX_LIST) {
    premEntries.push(`*... dan ${allPrem.length - MAX_LIST} lainnya*`);
  }

  const premSection = [
    `👥 **Pengguna Premium**`,
    ``,
    premEntries.length > 0
      ? premEntries.join(`\n\n`)
      : `*Belum ada pengguna Premium.*`,
  ].join("\n");

  // ── Section: Pengguna Limit Kustom ───────────────────────────────────
  const limEntries = [];
  for (const u of limUsers.slice(0, MAX_LIST)) {
    const usage = db.getUsage(u.userId);
    const sisa  = Math.max(0, u.limit - usage);
    const sisa2 = formatSisa(u.expiresAt);
    const berlakuBlock = sisa2 === null
      ? `♾️ Permanen`
      : `⏳ Berlaku :\n${sisa2}`;
    limEntries.push(
      `👤 <@${u.userId}>\n\n📦 Limit : ${u.limit} / Hari\n\n📉 Sisa : ${sisa}\n\n${berlakuBlock}`
    );
  }
  for (const r of limRoles.slice(0, MAX_LIST - limEntries.length)) {
    const sisa2 = formatSisa(r.expiresAt);
    const berlakuBlock = sisa2 === null
      ? `♾️ Permanen`
      : `⏳ Berlaku :\n${sisa2}`;
    limEntries.push(
      `👤 <@&${r.roleId}>\n\n📦 Limit : ${r.limit} / Hari\n\n${berlakuBlock}`
    );
  }
  if (allLim.length > MAX_LIST) {
    limEntries.push(`*... dan ${allLim.length - MAX_LIST} lainnya*`);
  }

  const limSection = [
    `🎵 **Pengguna Limit Kustom**`,
    ``,
    limEntries.length > 0
      ? limEntries.join(`\n\n`)
      : `*Belum ada pengguna Limit Kustom.*`,
  ].join("\n");

  // ── Section: Terakhir Diperbarui ─────────────────────────────────────
  const updateSection = `🕒 **Terakhir Diperbarui**\n\n${wib.date}\n${wib.time}`;

  // ── Assemble description ─────────────────────────────────────────────
  const desc = [
    SEP,
    summaryLines.join("\n"),
    SEP,
    premSection,
    SEP,
    limSection,
    SEP,
    updateSection,
    SEP,
  ].join("\n\n");

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("👑 Premium Statistics")
    .setDescription(desc.slice(0, 4096)) // Discord hard limit
    .setFooter({ text: "🔄 Diperbarui otomatis setiap ada perubahan." });
}

function buildRefreshButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ps:refresh")
      .setLabel("Perbarui")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Recalculate and update (or create) the single Premium Stats panel.
 * No-op if /premstats has not been run yet (no channelId stored).
 *
 * @param {import("discord.js").Client} client
 */
export async function updatePremStatsDashboard(client) {
  try {
    const state = premDB.getPremStatsDashboardState();
    if (!state.channelId) return; // /premstats not run yet

    const ch = await client.channels.fetch(state.channelId).catch(() => null);
    if (!ch?.isTextBased()) {
      logger.warn(`[PremStats] Channel ${state.channelId} not found or not text-based`);
      return;
    }

    const payload = {
      embeds:     [buildPremStatsEmbed()],
      components: [buildRefreshButton()],
    };

    if (state.messageId) {
      try {
        const msg = await ch.messages.fetch(state.messageId);
        await msg.edit(payload);
        logger.debug("[PremStats] Dashboard updated");
        return;
      } catch {
        logger.info("[PremStats] Previous dashboard message gone — creating new one");
      }
    }

    const newMsg = await ch.send(payload);
    premDB.setPremStatsDashboardState({ messageId: newMsg.id });
    logger.info(`[PremStats] Dashboard created: ${newMsg.id}`);
  } catch (e) {
    logger.error(`[PremStats] Failed to update dashboard: ${e.message}`);
  }
}
