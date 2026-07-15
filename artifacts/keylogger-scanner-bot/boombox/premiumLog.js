/**
 * premiumLog.js — Premium action log system.
 *
 * Every action sends a BRAND NEW embed message to PREMIUM_DASHBOARD_CHANNEL_ID.
 * Old log messages are NEVER edited — one action = one message.
 *
 * Supported actions:
 *   "Premium Added"    → 👑 Premium Ditambahkan
 *   "Premium Removed"  → ❌ Premium Dihapus
 *   "Premium Expired"  → ⌛ Premium Berakhir
 *   "Limit Set"        → 🎵 Limit Diperbarui
 *   "Limit Reset"      → 🔄 Limit Direset
 */

import { EmbedBuilder } from "discord.js";
import { IDS } from "../config/ids.js";
import { logger } from "../utils/logger.js";

/**
 * Build the appropriate log embed based on the action type.
 * @param {object} entry
 * @param {string} entry.action
 * @param {string} entry.target       mention string
 * @param {number} [entry.limit]      for Limit Set: requests/day
 * @param {string} [entry.durationLabel] for Limit Set: human label e.g. "7 Hari"
 * @param {string} [entry.expiresAt]  ISO string or null
 * @param {string} entry.executor     mention string or "System"
 * @param {string} [entry.status]
 */
function buildLogEmbed(entry) {
  const nowUnix = Math.floor(Date.now() / 1000);

  switch (entry.action) {
    // ── 👑 Premium Ditambahkan ─────────────────────────────────────────────
    case "Premium Added": {
      const isPerm    = !entry.expiresAt;
      const expUnix   = entry.expiresAt
        ? Math.floor(new Date(entry.expiresAt).getTime() / 1000)
        : null;
      const durasiText = isPerm ? "Lifetime" : (entry.durationLabel ?? "—");
      const berakhirText = isPerm ? "♾" : `<t:${expUnix}:f>`;

      return new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("👑 Premium Ditambahkan")
        .addFields(
          { name: "Member",      value: entry.target,              inline: true  },
          { name: "Durasi",      value: durasiText,                inline: true  },
          { name: "Aktif Mulai", value: `<t:${nowUnix}:f>`,       inline: false },
          { name: "Berakhir",    value: berakhirText,              inline: true  },
          { name: "Admin",       value: entry.executor,            inline: true  },
          { name: "Status",      value: "✅ Berhasil",             inline: true  },
        )
        .setTimestamp();
    }

    // ── ❌ Premium Dihapus ─────────────────────────────────────────────────
    case "Premium Removed": {
      const statusText = (entry.status === "Success" || !entry.status)
        ? "✅ Berhasil"
        : `ℹ️ ${entry.status}`;

      return new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("❌ Premium Dihapus")
        .addFields(
          { name: "Member", value: entry.target,              inline: true  },
          { name: "Admin",  value: entry.executor,            inline: true  },
          { name: "Waktu",  value: `<t:${nowUnix}:f>`,       inline: false },
          { name: "Status", value: statusText,                inline: true  },
        )
        .setTimestamp();
    }

    // ── ⚠ Premium Expired ─────────────────────────────────────────────────
    case "Premium Expired": {
      const expUnix = entry.expiredAt
        ? Math.floor(new Date(entry.expiredAt).getTime() / 1000)
        : nowUnix;
      return new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle("⚠ Premium Expired")
        .addFields(
          { name: "👤 User",      value: entry.target,          inline: true },
          { name: "👑 Premium",   value: entry.premiumLabel ?? "Temporary", inline: true },
          { name: "📅 Expired At",value: `<t:${expUnix}:f>`,    inline: true },
        )
        .setTimestamp();
    }

    // ── ⚠ Custom Limit Expired ───────────────────────────────────────────
    case "Custom Limit Expired": {
      const expUnix = entry.expiredAt
        ? Math.floor(new Date(entry.expiredAt).getTime() / 1000)
        : nowUnix;
      return new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle("⚠ Custom Limit Expired")
        .addFields(
          { name: "👤 User",       value: entry.target,                    inline: true },
          { name: "🎵 Limit",      value: entry.limit != null ? `${entry.limit} Request/Hari` : "—", inline: true },
          { name: "📅 Expired At", value: `<t:${expUnix}:f>`,              inline: true },
        )
        .setTimestamp();
    }

    // ── 🎵 Limit Diperbarui ───────────────────────────────────────────────
    case "Limit Set": {
      const isPerm      = !entry.expiresAt;
      const expUnix     = entry.expiresAt
        ? Math.floor(new Date(entry.expiresAt).getTime() / 1000)
        : null;
      const limitText   = entry.limit != null ? `${entry.limit} Request/Hari` : "—";
      const durasiText  = isPerm ? "Lifetime" : (entry.durationLabel ?? "—");
      const expireText  = isPerm ? "♾" : `<t:${expUnix}:f>`;

      return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🎵 Limit Diperbarui")
        .addFields(
          { name: "Target",   value: entry.target,          inline: true },
          { name: "Limit",    value: limitText,             inline: true },
          { name: "Duration", value: durasiText,            inline: true },
          { name: "Started",  value: `<t:${nowUnix}:f>`,   inline: true },
          { name: "Expire",   value: expireText,            inline: true },
          { name: "Admin",    value: entry.executor,        inline: true },
          { name: "Status",   value: "✅ Berhasil",         inline: true },
        )
        .setTimestamp();
    }

    // ── 🔄 Limit Direset ──────────────────────────────────────────────────
    case "Limit Reset": {
      return new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("🔄 Limit Direset")
        .addFields(
          { name: "Target", value: entry.target,              inline: true  },
          { name: "Admin",  value: entry.executor,            inline: true  },
          { name: "Waktu",  value: `<t:${nowUnix}:f>`,       inline: false },
          { name: "Status", value: "✅ Berhasil",             inline: true  },
        )
        .setTimestamp();
    }

    // ── Fallback ──────────────────────────────────────────────────────────
    default: {
      return new EmbedBuilder()
        .setColor(0x99aab5)
        .setTitle(`📋 ${entry.action}`)
        .addFields(
          { name: "Target",   value: entry.target   || "—", inline: true },
          { name: "Executor", value: entry.executor || "—", inline: true },
          { name: "Status",   value: entry.status   || "—", inline: true },
        )
        .setTimestamp();
    }
  }
}

/**
 * Send a new embed log message for the given action.
 * NEVER edits any previous message.
 *
 * @param {import("discord.js").Client} client
 * @param {object} entry — see buildLogEmbed for fields
 */
export async function appendToPremiumLog(client, entry) {
  try {
    const ch = await client.channels.fetch(IDS.PREMIUM_DASHBOARD_CHANNEL_ID).catch(() => null);
    if (!ch?.isTextBased()) {
      logger.warn(`[Premium] Log channel ${IDS.PREMIUM_DASHBOARD_CHANNEL_ID} not found or not text-based`);
      return;
    }
    const embed = buildLogEmbed(entry);
    await ch.send({ embeds: [embed] });
  } catch (e) {
    logger.error(`[Premium] Failed to send log embed: ${e.message}`);
  }
}
