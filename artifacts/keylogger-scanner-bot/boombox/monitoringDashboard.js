/**
 * monitoringDashboard.js — Premium Monitoring Dashboard.
 *
 * Maintains a SINGLE message in MONITORING_CHANNEL_ID.
 * Every call to updateMonitoringDashboard() edits that one message in place
 * (or creates it if missing). Never spams new messages.
 *
 * The message is recreated automatically if it was deleted.
 *
 * Auto-updated by: /addprem, /removeprem, /setlimit, /resetlimit,
 * premium auto-expiration, and bot restart.
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { IDS } from "../config/ids.js";
import { premDB } from "./db.js";
import { logger } from "../utils/logger.js";

// ── Stats calculation ──────────────────────────────────────────────────────

/** Nearest upcoming expiry across all active temporary grants, or null. */
function nextExpiredLabel(allPrem, allLim) {
  const candidates = [...allPrem, ...allLim].filter(r => r.expiresAt);
  if (candidates.length === 0) return "Tidak ada";
  const soonest = candidates.reduce((a, b) =>
    new Date(a.expiresAt) < new Date(b.expiresAt) ? a : b
  );
  return `<t:${Math.floor(new Date(soonest.expiresAt).getTime() / 1000)}:R>`;
}

function calcStats() {
  const now = new Date();

  // Active premium users (non-expired)
  const premUsers = premDB.getAllPremiumUsers().filter(u =>
    !u.expiresAt || new Date(u.expiresAt) > now
  );
  // Active premium roles (non-expired)
  const premRoles = premDB.getAllPremiumRoles().filter(r =>
    !r.expiresAt || new Date(r.expiresAt) > now
  );

  // Active custom limit users (uses DB's own expiry check)
  const limUsers = premDB.getAllCustomLimitUsers().filter(u =>
    premDB.getCustomLimitUser(u.userId) !== null
  );
  // Active custom limit roles
  const limRoles = premDB.getAllCustomLimitRoles().filter(r =>
    premDB.getCustomLimitRole(r.roleId) !== null
  );

  const allPrem = [...premUsers, ...premRoles];
  const allLim  = [...limUsers,  ...limRoles];

  return {
    premiumActive:        allPrem.length,
    customLimitActive:    allLim.length,
    permanentPremium:     allPrem.filter(r => r.type === "permanent").length,
    temporaryPremium:     allPrem.filter(r => r.type === "temporary").length,
    permanentCustomLimit: allLim.filter(r => r.type  === "permanent").length,
    temporaryCustomLimit: allLim.filter(r => r.type  === "temporary").length,
    lastPremiumUser:      premDB.getLastPremiumTarget() ?? "Belum ada",
    lastCustomLimitUser:  premDB.getLastCustomLimitTarget() ?? "Belum ada",
    nextExpired:          nextExpiredLabel(allPrem, allLim),
  };
}

// ── Embed & buttons builders ───────────────────────────────────────────────

function buildDashboardEmbed(stats) {
  const nowUnix = Math.floor(Date.now() / 1000);

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("👑 Premium Monitoring")
    .setDescription("Status Premium & Custom Limit BoomBox, diperbarui secara live.")
    .addFields(
      { name: "👑 Premium Active",         value: `${stats.premiumActive}`,         inline: true  },
      { name: "🎵 Custom Limit Active",    value: `${stats.customLimitActive}`,     inline: true  },
      { name: "\u200B",                    value: "\u200B",                         inline: true  },
      { name: "💎 Permanent Premium",      value: `${stats.permanentPremium}`,      inline: true  },
      { name: "⏳ Temporary Premium",      value: `${stats.temporaryPremium}`,      inline: true  },
      { name: "\u200B",                    value: "\u200B",                         inline: true  },
      { name: "💎 Permanent Custom Limit", value: `${stats.permanentCustomLimit}`,  inline: true  },
      { name: "⏳ Temporary Custom Limit", value: `${stats.temporaryCustomLimit}`,  inline: true  },
      { name: "\u200B",                    value: "\u200B",                         inline: true  },
      { name: "👤 Last Premium User",      value: stats.lastPremiumUser,            inline: true  },
      { name: "🎵 Last Custom Limit User", value: stats.lastCustomLimitUser,        inline: true  },
      { name: "\u200B",                    value: "\u200B",                         inline: true  },
      { name: "⌛ Next Expired",           value: stats.nextExpired,                inline: true  },
      { name: "📅 Last Update",            value: `<t:${nowUnix}:f>`,              inline: true  },
      { name: "🔄 Auto Refresh Status",    value: "✅ Aktif (live update)",         inline: true  },
    )
    .setFooter({ text: "Auto-refreshes on every change • Premium Monitoring" })
    .setTimestamp();
}

function buildDashboardButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("mon:premium")
      .setLabel("Premium")
      .setEmoji("👑")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("mon:limits")
      .setLabel("Custom Limit")
      .setEmoji("🎵")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("mon:expiring")
      .setLabel("Expired Soon")
      .setEmoji("⌛")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("mon:refresh")
      .setLabel("Refresh")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Recalculate all stats and update (or create) the single monitoring dashboard
 * message. Safe to call from any command or sweep — catches all errors internally.
 *
 * @param {import("discord.js").Client} client
 */
export async function updateMonitoringDashboard(client) {
  try {
    const ch = await client.channels.fetch(IDS.MONITORING_CHANNEL_ID).catch(() => null);
    if (!ch?.isTextBased()) {
      logger.warn("[Monitor] Monitoring channel not found or not text-based");
      return;
    }

    const stats  = calcStats();
    const embed  = buildDashboardEmbed(stats);
    const row    = buildDashboardButtons();
    const payload = { embeds: [embed], components: [row] };

    // Try to edit the existing dashboard message.
    const existingId = premDB.getDashboardMessageId();
    if (existingId) {
      try {
        const msg = await ch.messages.fetch(existingId);
        await msg.edit(payload);
        logger.debug("[Monitor] Dashboard updated");
        return;
      } catch {
        // Message was deleted — fall through to create a new one.
        logger.info("[Monitor] Previous dashboard message gone — creating a new one");
      }
    }

    // No existing message (or it was deleted): send a fresh one.
    const newMsg = await ch.send(payload);
    premDB.setDashboardMessageId(newMsg.id);
    logger.info(`[Monitor] Dashboard created: ${newMsg.id}`);
  } catch (e) {
    logger.error(`[Monitor] Failed to update dashboard: ${e.message}`);
  }
}
