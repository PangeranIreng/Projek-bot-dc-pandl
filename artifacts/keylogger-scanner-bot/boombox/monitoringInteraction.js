/**
 * monitoringInteraction.js — Handles all Discord interactions whose customId
 * starts with "mon:" (monitoring dashboard buttons + select menus).
 *
 * Dashboard buttons (on the monitoring channel message):
 *   mon:premium  → ephemeral paginated Premium list
 *   mon:limits   → ephemeral paginated Custom Limit list
 *   mon:refresh  → recalculate stats and edit the dashboard message
 *
 * Premium list pagination buttons (on ephemeral):
 *   mon:pp:PAGE:TOTAL  ← previous page
 *   mon:pn:PAGE:TOTAL  ← next page
 *   mon:ps:TOTAL       ← show page-select StringSelectMenu
 *
 * Premium list select menu:
 *   mon:pg:TOTAL  (value = chosen page number string)
 *
 * Custom Limit list pagination:
 *   mon:lp:PAGE:TOTAL / mon:ln:PAGE:TOTAL / mon:ls:TOTAL / mon:lg:TOTAL
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { premDB } from "./db.js";
import { updateMonitoringDashboard } from "./monitoringDashboard.js";
import { logger } from "../utils/logger.js";

const ENTRIES_PER_PAGE = 5;

const CIRCLED = [
  "①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩",
  "⑪","⑫","⑬","⑭","⑮","⑯","⑰","⑱","⑲","⑳",
];
function circled(n) {
  return n >= 1 && n <= 20 ? CIRCLED[n - 1] : `[${n}]`;
}

// ── Duration helpers ───────────────────────────────────────────────────────

/** Urgency emoji based on time remaining. */
function urgencyEmoji(expiresAt) {
  if (!expiresAt) return "💎"; // permanent
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0)          return "⏰"; // already expired (shouldn't appear)
  if (ms < 86_400_000)  return "🔴"; // < 1 day
  if (ms < 259_200_000) return "🟠"; // < 3 days
  if (ms < 604_800_000) return "🟡"; // < 7 days
  return "🟢";
}

/** Human-readable time remaining label. */
function timeRemainingLabel(expiresAt) {
  if (!expiresAt) return "Lifetime";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "Berakhir";
  const totalSec = Math.floor(ms / 1000);
  const days  = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins  = Math.floor((totalSec % 3600)  / 60);
  if (days  >= 1) return `${days} Hari${hours > 0 ? ` ${hours} Jam` : ""}`;
  if (hours >= 1) return `${hours} Jam${mins > 0 ? ` ${mins} Menit` : ""}`;
  return `${mins} Menit`;
}

// ── Data fetchers ──────────────────────────────────────────────────────────

/** Active Premium entries (users + roles), permanent first then by time asc. */
function getPremiumEntries() {
  const now = new Date();

  const users = premDB.getAllPremiumUsers()
    .filter(u => !u.expiresAt || new Date(u.expiresAt) > now)
    .map(u => ({ mention: `<@${u.userId}>`,  expiresAt: u.expiresAt }));

  const roles = premDB.getAllPremiumRoles()
    .filter(r => !r.expiresAt || new Date(r.expiresAt) > now)
    .map(r => ({ mention: `<@&${r.roleId}>`, expiresAt: r.expiresAt }));

  const all = [...users, ...roles];
  all.sort((a, b) => {
    if (!a.expiresAt && !b.expiresAt) return 0;
    if (!a.expiresAt) return -1; // permanent first
    if (!b.expiresAt) return  1;
    return new Date(a.expiresAt) - new Date(b.expiresAt); // earlier expiry first
  });
  return all;
}

/** Active Custom Limit entries (roles first, then users). */
function getLimitEntries() {
  const roles = premDB.getAllCustomLimitRoles()
    .filter(r => premDB.getCustomLimitRole(r.roleId) !== null)
    .map(r => ({ mention: `<@&${r.roleId}>`, limit: r.limit }));

  const users = premDB.getAllCustomLimitUsers()
    .filter(u => premDB.getCustomLimitUser(u.userId) !== null)
    .map(u => ({ mention: `<@${u.userId}>`,  limit: u.limit }));

  return [...roles, ...users];
}

/** Active entries (Premium + Custom Limit) that have a real expiry, soonest first. */
function getExpiringEntries() {
  const now = new Date();

  const premUsers = premDB.getAllPremiumUsers()
    .filter(u => u.expiresAt && new Date(u.expiresAt) > now)
    .map(u => ({ mention: `<@${u.userId}>`,  expiresAt: u.expiresAt, kind: "👑 Premium" }));
  const premRoles = premDB.getAllPremiumRoles()
    .filter(r => r.expiresAt && new Date(r.expiresAt) > now)
    .map(r => ({ mention: `<@&${r.roleId}>`, expiresAt: r.expiresAt, kind: "👑 Premium" }));
  const limUsers = premDB.getAllCustomLimitUsers()
    .filter(u => premDB.getCustomLimitUser(u.userId) !== null && u.expiresAt)
    .map(u => ({ mention: `<@${u.userId}>`,  expiresAt: u.expiresAt, kind: "🎵 Custom Limit" }));
  const limRoles = premDB.getAllCustomLimitRoles()
    .filter(r => premDB.getCustomLimitRole(r.roleId) !== null && r.expiresAt)
    .map(r => ({ mention: `<@&${r.roleId}>`, expiresAt: r.expiresAt, kind: "🎵 Custom Limit" }));

  const all = [...premUsers, ...premRoles, ...limUsers, ...limRoles];
  all.sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
  return all;
}

// ── Embed builders ─────────────────────────────────────────────────────────

function buildPremiumListEmbed(entries, page, totalPages) {
  const startIdx = (page - 1) * ENTRIES_PER_PAGE;
  const slice    = entries.slice(startIdx, startIdx + ENTRIES_PER_PAGE);

  const lines = slice.map((e, i) => {
    const n     = startIdx + i + 1;
    const emoji = urgencyEmoji(e.expiresAt);
    const label = timeRemainingLabel(e.expiresAt);
    return `${circled(n)} ${e.mention}\n${emoji} ${label}`;
  });

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("👑 Premium List")
    .setDescription(lines.length > 0 ? lines.join("\n\n") : "Tidak ada data.")
    .setFooter({ text: `Halaman ${page} / ${totalPages} • Total: ${entries.length} entri` })
    .setTimestamp();
}

function buildLimitListEmbed(entries, page, totalPages) {
  const startIdx = (page - 1) * ENTRIES_PER_PAGE;
  const slice    = entries.slice(startIdx, startIdx + ENTRIES_PER_PAGE);

  const lines = slice.map((e, i) => {
    const n         = startIdx + i + 1;
    const limitText = e.limit >= 9999 ? "💎 Unlimited" : `${e.limit} Request/Hari`;
    return `${circled(n)} ${e.mention}\n${limitText}`;
  });

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎵 Custom Limit List")
    .setDescription(lines.length > 0 ? lines.join("\n\n") : "Tidak ada data.")
    .setFooter({ text: `Halaman ${page} / ${totalPages} • Total: ${entries.length} entri` })
    .setTimestamp();
}

function buildExpiringListEmbed(entries, page, totalPages) {
  const startIdx = (page - 1) * ENTRIES_PER_PAGE;
  const slice    = entries.slice(startIdx, startIdx + ENTRIES_PER_PAGE);

  const lines = slice.map((e, i) => {
    const n     = startIdx + i + 1;
    const emoji = urgencyEmoji(e.expiresAt);
    const label = timeRemainingLabel(e.expiresAt);
    return `${circled(n)} ${e.mention} — ${e.kind}\n${emoji} ${label}`;
  });

  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("⌛ Expired Soon")
    .setDescription(lines.length > 0 ? lines.join("\n\n") : "Tidak ada yang akan berakhir.")
    .setFooter({ text: `Halaman ${page} / ${totalPages} • Total: ${entries.length} entri` })
    .setTimestamp();
}

// ── Component builders ─────────────────────────────────────────────────────

/**
 * Navigation button row.
 * @param {"p"|"l"} type  "p" = premium, "l" = limits
 */
function buildNavButtons(type, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mon:${type}p:${page}:${totalPages}`)
      .setLabel("⬅")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`mon:${type}n:${page}:${totalPages}`)
      .setLabel("➡")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`mon:${type}s:${totalPages}`)
      .setLabel("📄 Pilih Halaman")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(totalPages <= 1),
  );
}

/**
 * Page-select StringSelectMenu row.
 * @param {"p"|"l"} type
 */
function buildSelectRow(type, totalPages) {
  const options = Array.from({ length: Math.min(totalPages, 25) }, (_, i) => ({
    label: `Halaman ${i + 1}`,
    value: `${i + 1}`,
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`mon:${type}g:${totalPages}`)
      .setPlaceholder("Pilih halaman...")
      .addOptions(options),
  );
}

// ── Main handler ───────────────────────────────────────────────────────────

/**
 * Route and handle all mon:* interactions.
 * @param {import("discord.js").Interaction} interaction
 * @param {import("discord.js").Client}      client
 */
export async function handleMonitoringInteraction(interaction, client) {
  const id = interaction.customId ?? "";

  try {
    // ── Dashboard-level buttons ──────────────────────────────────────────

    if (id === "mon:premium") {
      const entries    = getPremiumEntries();
      const totalPages = Math.max(1, Math.ceil(entries.length / ENTRIES_PER_PAGE));
      await interaction.reply({
        embeds:     [buildPremiumListEmbed(entries, 1, totalPages)],
        components: [buildNavButtons("p", 1, totalPages)],
        ephemeral:  true,
      });
      return;
    }

    if (id === "mon:limits") {
      const entries    = getLimitEntries();
      const totalPages = Math.max(1, Math.ceil(entries.length / ENTRIES_PER_PAGE));
      await interaction.reply({
        embeds:     [buildLimitListEmbed(entries, 1, totalPages)],
        components: [buildNavButtons("l", 1, totalPages)],
        ephemeral:  true,
      });
      return;
    }

    if (id === "mon:expiring") {
      const entries    = getExpiringEntries();
      const totalPages = Math.max(1, Math.ceil(entries.length / ENTRIES_PER_PAGE));
      await interaction.reply({
        embeds:     [buildExpiringListEmbed(entries, 1, totalPages)],
        components: [buildNavButtons("e", 1, totalPages)],
        ephemeral:  true,
      });
      return;
    }

    if (id === "mon:refresh") {
      // Acknowledge immediately so Discord doesn't show "interaction failed".
      await interaction.deferUpdate();
      await updateMonitoringDashboard(client);
      return;
    }

    // ── Premium list pagination ──────────────────────────────────────────

    const ppMatch = /^mon:pp:(\d+):(\d+)$/.exec(id);
    if (ppMatch) {
      const [, cur, tot] = ppMatch.map(Number);
      const page  = Math.max(1, cur - 1);
      const total = tot;
      const entries = getPremiumEntries();
      await interaction.update({
        embeds:     [buildPremiumListEmbed(entries, page, total)],
        components: [buildNavButtons("p", page, total)],
      });
      return;
    }

    const pnMatch = /^mon:pn:(\d+):(\d+)$/.exec(id);
    if (pnMatch) {
      const [, cur, tot] = pnMatch.map(Number);
      const page  = Math.min(tot, cur + 1);
      const total = tot;
      const entries = getPremiumEntries();
      await interaction.update({
        embeds:     [buildPremiumListEmbed(entries, page, total)],
        components: [buildNavButtons("p", page, total)],
      });
      return;
    }

    const psMatch = /^mon:ps:(\d+)$/.exec(id);
    if (psMatch) {
      const total = Number(psMatch[1]);
      await interaction.update({
        content:    "📄 Pilih halaman Premium:",
        embeds:     [],
        components: [buildSelectRow("p", total)],
      });
      return;
    }

    const pgMatch = /^mon:pg:(\d+)$/.exec(id);
    if (pgMatch && interaction.isStringSelectMenu()) {
      const total   = Number(pgMatch[1]);
      const page    = Number(interaction.values[0]);
      const entries = getPremiumEntries();
      await interaction.update({
        content:    null,
        embeds:     [buildPremiumListEmbed(entries, page, total)],
        components: [buildNavButtons("p", page, total)],
      });
      return;
    }

    // ── Custom Limit list pagination ─────────────────────────────────────

    const lpMatch = /^mon:lp:(\d+):(\d+)$/.exec(id);
    if (lpMatch) {
      const [, cur, tot] = lpMatch.map(Number);
      const page  = Math.max(1, cur - 1);
      const total = tot;
      const entries = getLimitEntries();
      await interaction.update({
        embeds:     [buildLimitListEmbed(entries, page, total)],
        components: [buildNavButtons("l", page, total)],
      });
      return;
    }

    const lnMatch = /^mon:ln:(\d+):(\d+)$/.exec(id);
    if (lnMatch) {
      const [, cur, tot] = lnMatch.map(Number);
      const page  = Math.min(tot, cur + 1);
      const total = tot;
      const entries = getLimitEntries();
      await interaction.update({
        embeds:     [buildLimitListEmbed(entries, page, total)],
        components: [buildNavButtons("l", page, total)],
      });
      return;
    }

    const lsMatch = /^mon:ls:(\d+)$/.exec(id);
    if (lsMatch) {
      const total = Number(lsMatch[1]);
      await interaction.update({
        content:    "📄 Pilih halaman Custom Limit:",
        embeds:     [],
        components: [buildSelectRow("l", total)],
      });
      return;
    }

    const lgMatch = /^mon:lg:(\d+)$/.exec(id);
    if (lgMatch && interaction.isStringSelectMenu()) {
      const total   = Number(lgMatch[1]);
      const page    = Number(interaction.values[0]);
      const entries = getLimitEntries();
      await interaction.update({
        content:    null,
        embeds:     [buildLimitListEmbed(entries, page, total)],
        components: [buildNavButtons("l", page, total)],
      });
      return;
    }

    // ── Expiring Soon list pagination ────────────────────────────────────

    const epMatch = /^mon:ep:(\d+):(\d+)$/.exec(id);
    if (epMatch) {
      const [, cur, tot] = epMatch.map(Number);
      const page    = Math.max(1, cur - 1);
      const total   = tot;
      const entries = getExpiringEntries();
      await interaction.update({
        embeds:     [buildExpiringListEmbed(entries, page, total)],
        components: [buildNavButtons("e", page, total)],
      });
      return;
    }

    const enMatch = /^mon:en:(\d+):(\d+)$/.exec(id);
    if (enMatch) {
      const [, cur, tot] = enMatch.map(Number);
      const page    = Math.min(tot, cur + 1);
      const total   = tot;
      const entries = getExpiringEntries();
      await interaction.update({
        embeds:     [buildExpiringListEmbed(entries, page, total)],
        components: [buildNavButtons("e", page, total)],
      });
      return;
    }

    const esMatch = /^mon:es:(\d+)$/.exec(id);
    if (esMatch) {
      const total = Number(esMatch[1]);
      await interaction.update({
        content:    "📄 Pilih halaman Expired Soon:",
        embeds:     [],
        components: [buildSelectRow("e", total)],
      });
      return;
    }

    const egMatch = /^mon:eg:(\d+)$/.exec(id);
    if (egMatch && interaction.isStringSelectMenu()) {
      const total   = Number(egMatch[1]);
      const page    = Number(interaction.values[0]);
      const entries = getExpiringEntries();
      await interaction.update({
        content:    null,
        embeds:     [buildExpiringListEmbed(entries, page, total)],
        components: [buildNavButtons("e", page, total)],
      });
      return;
    }

  } catch (e) {
    logger.error(`[Monitor] Interaction error for "${id}": ${e.message}`);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Terjadi kesalahan.", ephemeral: true }).catch(() => {});
    }
  }
}
