/**
 * src/utils/configValidator.js — Startup validation untuk seluruh konfigurasi bot.
 *
 * Dijalankan SEKALI saat bot ready (dari ready.js).
 * Memeriksa apakah channel dan role yang dikonfigurasi via /setup masih ada di Discord.
 * Jika ada yang tidak valid:
 *   - Log warning yang jelas ke console (stdout)
 *   - Kirim notifikasi ke DATABASE console channel (jika dikonfigurasi)
 *   - TIDAK menghentikan fitur apapun — bot tetap berjalan
 *
 * Tidak mengubah data konfigurasi — hanya memberikan notifikasi.
 */

import { logger }       from "./logger.js";
import { db, premDB, ltDB } from "../database/db.js";
import { ticketDB }         from "../database/ticketDB.js";
import { bugReportDB }      from "../database/bugReportDB.js";
import { databaseDB }       from "../database/databaseDB.js";
import { IDS }              from "../../config/constants.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Check if a channel ID still exists and is accessible.
 * Returns { ok: true } if channelId is null/undefined (not configured = skip).
 * @param {import("discord.js").Client} client
 * @param {string|null|undefined} channelId
 * @param {string} label  Human-readable name for the log message
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function _checkChannel(client, channelId, label) {
  if (!channelId) return { ok: true }; // belum dikonfigurasi — lewati

  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) {
      return {
        ok:     false,
        reason: `Channel **${label}** (ID: \`${channelId}\`) tidak ditemukan — kemungkinan sudah dihapus`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok:     false,
      reason: `Gagal memverifikasi channel **${label}** (${channelId}): ${e.message}`,
    };
  }
}

/**
 * Check if a role ID still exists in the guild.
 * Returns { ok: true } if roleId is null/undefined.
 * @param {import("discord.js").Guild} guild
 * @param {string|null|undefined} roleId
 * @param {string} label
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function _checkRole(guild, roleId, label) {
  if (!roleId) return { ok: true }; // belum dikonfigurasi — lewati

  try {
    const role =
      guild.roles.cache.get(roleId) ??
      (await guild.roles.fetch(roleId).catch(() => null));

    if (!role) {
      return {
        ok:     false,
        reason: `Role **${label}** (ID: \`${roleId}\`) tidak ditemukan — kemungkinan sudah dihapus`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok:     false,
      reason: `Gagal memverifikasi role **${label}** (${roleId}): ${e.message}`,
    };
  }
}

/**
 * Accumulate a check result into the `issues` array.
 * @param {{ ok: boolean, reason?: string }} result
 * @param {string} feature  e.g. "BoomBox", "Ticket"
 * @param {{ feature: string, reason: string }[]} issues
 */
function _collect(result, feature, issues) {
  if (!result.ok && result.reason) {
    issues.push({ feature, reason: result.reason });
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Validate all /setup-configured channels and roles at startup.
 *
 * - Checks BoomBox, Ticket, Bug Report, Lua Tools, Database, Premium Stats.
 * - Logs one warning per invalid item.
 * - Sends a summary notification to the DATABASE console channel (if available).
 * - Never throws, never disables features, never modifies stored data.
 *
 * @param {import("discord.js").Client} client
 */
export async function runConfigValidation(client) {
  const guildId = IDS.GUILD_ID;
  const guild   = client.guilds.cache.get(guildId);

  if (!guild) {
    logger.warn("[ConfigValidator] Guild tidak ditemukan di cache — validasi dilewati");
    return;
  }

  const issues = [];

  // ── BoomBox ────────────────────────────────────────────────────────────────

  const bbChannels = db.getChannels();
  _collect(await _checkChannel(client, bbChannels.youtube, "BoomBox YouTube"),  "BoomBox", issues);
  _collect(await _checkChannel(client, bbChannels.tiktok,  "BoomBox TikTok"),   "BoomBox", issues);
  _collect(await _checkChannel(client, bbChannels.spotify, "BoomBox Spotify"),  "BoomBox", issues);
  _collect(await _checkChannel(client, db.getLogChannel(), "BoomBox Log"),       "BoomBox", issues);

  const bbLogChs = db.getPlatformLogChannels();
  _collect(await _checkChannel(client, bbLogChs.youtube, "BoomBox Log YouTube"), "BoomBox", issues);
  _collect(await _checkChannel(client, bbLogChs.tiktok,  "BoomBox Log TikTok"),  "BoomBox", issues);
  _collect(await _checkChannel(client, bbLogChs.spotify, "BoomBox Log Spotify"), "BoomBox", issues);

  // BoomBox role limits — low severity: just log individually, don't add to main issues
  const roleLimits = db.getRoleLimits();
  for (const roleId of Object.keys(roleLimits)) {
    const r = await _checkRole(guild, roleId, `BoomBox Role Limit`);
    if (!r.ok) {
      logger.warn(`[ConfigValidator] BoomBox: ${r.reason} — limit untuk role ini tidak akan berlaku`);
    }
  }

  // ── Ticket ─────────────────────────────────────────────────────────────────

  const tc = ticketDB.getConfig();
  _collect(await _checkChannel(client, tc.panelChannelId, "Ticket Panel"),   "Ticket", issues);
  _collect(await _checkChannel(client, tc.logsChannelId,  "Ticket Log"),     "Ticket", issues);
  _collect(await _checkChannel(client, tc.claimChannelId, "Ticket Claim"),   "Ticket", issues);
  _collect(await _checkRole(guild, tc.mentionRoleId, "Ticket Mention Role"), "Ticket", issues);
  _collect(await _checkRole(guild, tc.claimRoleId,   "Ticket Claim Role"),   "Ticket", issues);

  // ── Bug Report ─────────────────────────────────────────────────────────────

  const bc = bugReportDB.getConfig();
  _collect(await _checkChannel(client, bc.panelChannelId, "Bug Report Panel"),   "Bug Report", issues);
  _collect(await _checkChannel(client, bc.logsChannelId,  "Bug Report Log"),     "Bug Report", issues);
  _collect(await _checkRole(guild, bc.developerRoleId, "Bug Report Dev Role"),   "Bug Report", issues);

  // ── Lua Tools ──────────────────────────────────────────────────────────────

  const ltChs = ltDB.getChannels();
  _collect(await _checkChannel(client, ltChs.obfuscator,   "LuaTools Obfuscator"),   "LuaTools", issues);
  _collect(await _checkChannel(client, ltChs.beautify,     "LuaTools Beautify"),     "LuaTools", issues);
  _collect(await _checkChannel(client, ltChs.deobfuscator, "LuaTools Deobfuscator"), "LuaTools", issues);

  const ltLogChs = ltDB.getLogChannels();
  _collect(await _checkChannel(client, ltLogChs.obfuscator,   "LuaTools Log Obfuscator"),   "LuaTools", issues);
  _collect(await _checkChannel(client, ltLogChs.beautify,     "LuaTools Log Beautify"),     "LuaTools", issues);
  _collect(await _checkChannel(client, ltLogChs.deobfuscator, "LuaTools Log Deobfuscator"), "LuaTools", issues);

  // ── Database ───────────────────────────────────────────────────────────────

  const dbData = databaseDB.get();
  if (dbData.channels) {
    _collect(await _checkChannel(client, dbData.channels.botSetting,  "Database Bot Setting"),  "Database", issues);
    _collect(await _checkChannel(client, dbData.channels.backup,      "Database Backup"),       "Database", issues);
    _collect(await _checkChannel(client, dbData.channels.console,     "Database Console"),      "Database", issues);
    _collect(await _checkChannel(client, dbData.channels.memberList,  "Database Member List"),  "Database", issues);
  }

  // ── Premium Stats ──────────────────────────────────────────────────────────

  const ps = premDB.getPremStatsDashboardState();
  _collect(await _checkChannel(client, ps.channelId, "Premium Stats"), "Premium", issues);

  // ── Report ─────────────────────────────────────────────────────────────────

  if (issues.length === 0) {
    logger.info("[ConfigValidator] ✅ Semua konfigurasi valid — tidak ada channel/role yang hilang");
    return;
  }

  // Log each issue
  logger.warn(`[ConfigValidator] ⚠️ Ditemukan ${issues.length} masalah konfigurasi setelah startup:`);
  for (const { feature, reason } of issues) {
    logger.warn(`[ConfigValidator]   [${feature}] ${reason}`);
  }

  // Notify via DATABASE console channel (if configured) — non-fatal if unavailable
  try {
    const { consoleLog } = await import("../features/database/console.js");
    await consoleLog(
      "warning",
      "Config Validation — Startup Check",
      `Ditemukan ${issues.length} konfigurasi tidak valid:\n` +
      issues.map(i => `• [${i.feature}] ${i.reason.replace(/\*\*/g, "")}`).join("\n"),
    ).catch(() => {});
  } catch { /* DATABASE console belum dikonfigurasi — abaikan */ }
}
