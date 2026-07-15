/**
 * ticketInteraction.js — Handles all Discord interactions whose customId
 * starts with "ticket:" (panel button, claim/close/transcript/delete buttons,
 * dashboard nav buttons + select menus).
 *
 *   ticket:open
 *   ticket:claim:<number>
 *   ticket:close:<number>
 *   ticket:transcript:<number>
 *   ticket:delete:<number>
 *   ticket:dash:nav:<first|prev|refresh|next|last>:<page>:<filter>
 *   ticket:dash:pagesel:<filter>  (select, value = page number string)
 *   ticket:dash:filtersel         (select, value = filter string)
 */

import { openTicket, claimTicket, closeTicket, transcriptTicket, deleteTicket } from "./ticketHandler.js";
import { buildDashboardEmbed, buildDashboardComponents } from "./ticketDashboard.js";
import { ticketDB } from "./ticketDB.js";
import { logger } from "../utils/logger.js";

export async function handleTicketInteraction(interaction) {
  const id = interaction.customId ?? "";

  try {
    if (id === "ticket:open") {
      await openTicket(interaction);
      return;
    }

    const claimMatch = /^ticket:claim:(\d+)$/.exec(id);
    if (claimMatch) {
      await claimTicket(interaction, Number(claimMatch[1]));
      return;
    }

    const closeMatch = /^ticket:close:(\d+)$/.exec(id);
    if (closeMatch) {
      await closeTicket(interaction, Number(closeMatch[1]));
      return;
    }

    const transcriptMatch = /^ticket:transcript:(\d+)$/.exec(id);
    if (transcriptMatch) {
      await transcriptTicket(interaction, Number(transcriptMatch[1]));
      return;
    }

    const deleteMatch = /^ticket:delete:(\d+)$/.exec(id);
    if (deleteMatch) {
      await deleteTicket(interaction, Number(deleteMatch[1]));
      return;
    }

    const navMatch = /^ticket:dash:nav:(first|prev|refresh|next|last):(\d+):(\w+)$/.exec(id);
    if (navMatch) {
      const [, action, curPageStr, filter] = navMatch;
      const curPage = Number(curPageStr);
      let page = curPage;
      if (action === "first")        page = 1;
      else if (action === "prev")    page = Math.max(1, curPage - 1);
      else if (action === "next")    page = curPage + 1;
      else if (action === "last")    page = Number.MAX_SAFE_INTEGER; // clamped inside builders
      // "refresh" keeps the current page as-is.

      const tickets = ticketDB.getAllTickets();
      await interaction.update({
        embeds:     [buildDashboardEmbed(tickets, filter, page)],
        components: buildDashboardComponents(tickets, filter, page),
      });
      return;
    }

    if (id === "ticket:dash:filtersel" && interaction.isStringSelectMenu()) {
      const filter  = interaction.values[0];
      const tickets = ticketDB.getAllTickets();
      await interaction.update({
        embeds:     [buildDashboardEmbed(tickets, filter, 1)],
        components: buildDashboardComponents(tickets, filter, 1),
      });
      return;
    }

    const pageSelMatch = /^ticket:dash:pagesel:(\w+)$/.exec(id);
    if (pageSelMatch && interaction.isStringSelectMenu()) {
      const filter  = pageSelMatch[1];
      const page    = Number(interaction.values[0]);
      const tickets = ticketDB.getAllTickets();
      await interaction.update({
        embeds:     [buildDashboardEmbed(tickets, filter, page)],
        components: buildDashboardComponents(tickets, filter, page),
      });
      return;
    }
  } catch (e) {
    logger.error(`[Ticket] Interaction error for "${id}": ${e.message}`);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Terjadi kesalahan pada sistem Ticket.", ephemeral: true }).catch(() => {});
    }
  }
}
