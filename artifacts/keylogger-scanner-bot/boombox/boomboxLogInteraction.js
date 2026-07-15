/**
 * boomboxLogInteraction.js — Handles all Discord interactions whose customId
 * starts with "bblog:" (BoomBox Logs dashboard nav buttons + page select).
 *
 *   bblog:nav:<first|prev|refresh|next|last>:<page>
 *   bblog:viewall:<page>   →  ephemeral page-list + jump select
 *   bblog:pagesel          (select, value = page number string)
 */

import { db } from "./db.js";
import {
  buildLogDashboardEmbed,
  buildLogDashboardComponents,
  buildViewAllEmbed,
  buildViewAllSelectRow,
  resolvePage,
} from "./boomboxLogDashboard.js";
import { logger } from "../utils/logger.js";

export async function handleBoomBoxLogInteraction(interaction) {
  const id = interaction.customId ?? "";

  try {
    // ── First / Prev / Refresh / Next / Last ─────────────────────────────
    const navMatch = /^bblog:nav:(first|prev|refresh|next|last):(\d+)$/.exec(id);
    if (navMatch) {
      const [, action, curPageStr] = navMatch;
      const curPage = Number(curPageStr);
      const entries = db.getLogState().entries ?? [];
      const { totalPages } = resolvePage(entries, curPage);

      let page = curPage;
      if (action === "first")      page = 1;
      else if (action === "prev")  page = Math.max(1, curPage - 1);
      else if (action === "next")  page = Math.min(totalPages, curPage + 1);
      else if (action === "last")  page = totalPages;
      // "refresh" keeps current page as-is

      await interaction.update({
        embeds:     [buildLogDashboardEmbed(entries, page)],
        components: buildLogDashboardComponents(entries, page),
      });
      return;
    }

    // ── View All Pages ────────────────────────────────────────────────────
    const viewAllMatch = /^bblog:viewall:(\d+)$/.exec(id);
    if (viewAllMatch) {
      const entries    = db.getLogState().entries ?? [];
      const { totalPages } = resolvePage(entries, 1);
      await interaction.reply({
        embeds:     [buildViewAllEmbed(entries)],
        components: buildViewAllSelectRow(totalPages),
        ephemeral:  true,
      }).catch(() => {});
      return;
    }

    // ── Page select ───────────────────────────────────────────────────────
    if (id === "bblog:pagesel" && interaction.isStringSelectMenu()) {
      const page    = Number(interaction.values[0]);
      const entries = db.getLogState().entries ?? [];

      // This select could come from either the dashboard message (update in
      // place) or from a "View All Pages" ephemeral reply (update that reply).
      const isEphemeral = interaction.message?.flags?.has("Ephemeral") ??
        interaction.message?.ephemeral ?? false;

      if (isEphemeral) {
        // Jump request from View All Pages ephemeral — update the main dashboard
        // message directly, then acknowledge the ephemeral interaction.
        const state = db.getLogState();
        if (state.messageId && interaction.channel) {
          try {
            const dashMsg = await interaction.channel.messages
              .fetch(state.messageId)
              .catch(() => null);
            if (dashMsg) {
              await dashMsg.edit({
                embeds:     [buildLogDashboardEmbed(entries, page)],
                components: buildLogDashboardComponents(entries, page),
              });
            }
          } catch (editErr) {
            logger.warn(`[BoomBox] Failed to update dashboard from ephemeral page select: ${editErr.message}`);
          }
        }
        await interaction.reply({
          content:   `✅ Dashboard berpindah ke **Halaman ${page}**.`,
          ephemeral: true,
        }).catch(() => {});
      } else {
        await interaction.update({
          embeds:     [buildLogDashboardEmbed(entries, page)],
          components: buildLogDashboardComponents(entries, page),
        });
      }
      return;
    }
  } catch (e) {
    logger.error(`[BoomBox] Log interaction error for "${id}": ${e.message}`);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Terjadi kesalahan pada BoomBox Logs.", ephemeral: true }).catch(() => {});
    }
  }
}
