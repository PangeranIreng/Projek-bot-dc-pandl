/**
 * ticketDashboard.js — Ticket Logs dashboard.
 *
 * Maintains a SINGLE message in the configured logs_channel. Every call to
 * updateTicketDashboard() edits that one message in place (or creates it if
 * missing/deleted) — never spams the channel. Manual navigation (pagination
 * + filter) also edits the same message via interaction.update(), following
 * the same "one message, always edited" rule.
 *
 * Auto-updated by: ticket open / claim / close, and bot restart.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { ticketDB } from "./ticketDB.js";
import { padTicketNumber } from "./ticketUtils.js";
import { logger } from "../utils/logger.js";

const PAGE_SIZE = 10;
const SEP12 = "━━━━━━━━━━━━";

const FILTERS = {
  all:     { label: "📂 Semua Ticket",  emoji: "📂" },
  open:    { label: "🟡 Menunggu",      emoji: "🟡" },
  claimed: { label: "🟢 Di Handle",     emoji: "🟢" },
  closed:  { label: "🔴 Closed",        emoji: "🔴" },
};

function statusMeta(status) {
  if (status === "open")    return { emoji: "🟡", label: "Menunggu" };
  if (status === "claimed") return { emoji: "🟢", label: "Di Handle" };
  return { emoji: "🔴", label: "Closed" };
}

function filterTickets(tickets, filter) {
  if (filter === "open")    return tickets.filter((t) => t.status === "open");
  if (filter === "claimed") return tickets.filter((t) => t.status === "claimed");
  if (filter === "closed")  return tickets.filter((t) => t.status === "closed");
  return tickets;
}

/** Resolve a requested page against the current filtered/sorted ticket list. */
function resolvePage(tickets, filter, requestedPage) {
  const filtered = filterTickets(tickets, filter).slice().sort((a, b) => b.number - a.number);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return { filtered, totalPages, page, slice };
}

// ── Embed ──────────────────────────────────────────────────────────────────

export function buildDashboardEmbed(tickets, filter = "all", requestedPage = 1) {
  const { totalPages, page, slice } = resolvePage(tickets, filter, requestedPage);

  const total   = tickets.length;
  const waiting = tickets.filter((t) => t.status === "open").length;
  const handled = tickets.filter((t) => t.status === "claimed").length;
  const closed  = tickets.filter((t) => t.status === "closed").length;

  const header = [
    `📊 Total Ticket : ${total}`,
    "",
    `🟡 Menunggu : ${waiting}`,
    `🟢 Di Handle : ${handled}`,
    `🔴 Closed : ${closed}`,
    "",
    `📄 Halaman ${page} / ${totalPages}`,
  ].join("\n");

  const listLines = slice.map((t) => {
    const { emoji, label } = statusMeta(t.status);
    const who = t.status === "open"
      ? `👤 <@${t.userId}>`
      : `👨‍💻 ${t.handlerId ? `<@${t.handlerId}>` : "-"}`;
    return `#${padTicketNumber(t.number)} ${emoji} ${label}\n${who}`;
  });

  const list = listLines.length > 0
    ? listLines.join(`\n\n${SEP12}\n\n`)
    : "Belum ada Ticket.";

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📋 Ticket Logs")
    .setDescription(`${header}\n\n**Daftar Ticket:**\n\n${list}`)
    .setFooter({ text: `Filter: ${FILTERS[filter]?.label ?? FILTERS.all.label}` })
    .setTimestamp();
}

// ── Components ──────────────────────────────────────────────────────────────

function buildNavRow(filter, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:dash:nav:first:${page}:${filter}`).setEmoji("⏮️").setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`ticket:dash:nav:prev:${page}:${filter}`).setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`ticket:dash:nav:refresh:${page}:${filter}`).setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket:dash:nav:next:${page}:${filter}`).setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
    new ButtonBuilder().setCustomId(`ticket:dash:nav:last:${page}:${filter}`).setEmoji("⏭️").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
  );
}

function buildPageSelectRow(filter, totalPages) {
  const options = Array.from({ length: Math.min(totalPages, 25) }, (_, i) => ({
    label: `Halaman ${i + 1}`,
    value: `${i + 1}`,
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ticket:dash:pagesel:${filter}`)
      .setPlaceholder("📄 Pilih Halaman")
      .addOptions(options),
  );
}

function buildFilterSelectRow(filter) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ticket:dash:filtersel")
      .setPlaceholder("📂 Semua Ticket")
      .addOptions(
        Object.entries(FILTERS).map(([value, { label }]) => ({
          label,
          value,
          default: value === filter,
        })),
      ),
  );
}

export function buildDashboardComponents(tickets, filter = "all", requestedPage = 1) {
  const { totalPages, page } = resolvePage(tickets, filter, requestedPage);
  const rows = [buildNavRow(filter, page, totalPages)];
  if (totalPages > 1) rows.push(buildPageSelectRow(filter, totalPages));
  rows.push(buildFilterSelectRow(filter));
  return rows;
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Recalculate and update (or create) the single Ticket Logs dashboard
 * message. Safe to call from anywhere — catches all errors internally.
 * Always resets the shown view to page 1 / filter "all" since this is an
 * automatic refresh, not a viewer-driven navigation.
 *
 * @param {import("discord.js").Client} client
 */
export async function updateTicketDashboard(client) {
  try {
    const config = ticketDB.getConfig();
    if (!config.logsChannelId) return; // not configured yet

    const ch = await client.channels.fetch(config.logsChannelId).catch(() => null);
    if (!ch?.isTextBased()) {
      logger.warn(`[Ticket] Logs channel ${config.logsChannelId} not found or not text-based`);
      return;
    }

    const tickets = ticketDB.getAllTickets();
    const payload = {
      embeds:     [buildDashboardEmbed(tickets, "all", 1)],
      components: buildDashboardComponents(tickets, "all", 1),
    };

    if (config.dashboardMessageId) {
      try {
        const msg = await ch.messages.fetch(config.dashboardMessageId);
        await msg.edit(payload);
        logger.debug("[Ticket] Dashboard updated");
        return;
      } catch {
        logger.info("[Ticket] Previous dashboard message gone — creating a new one");
      }
    }

    const newMsg = await ch.send(payload);
    ticketDB.setConfig({ dashboardMessageId: newMsg.id });
    logger.info(`[Ticket] Dashboard created: ${newMsg.id}`);
  } catch (e) {
    logger.error(`[Ticket] Failed to update dashboard: ${e.message}`);
  }
}
