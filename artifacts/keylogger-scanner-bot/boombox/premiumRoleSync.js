/**
 * premiumRoleSync.js — Grants/revokes the real Discord Premium role
 * whenever a *user* (not a role) gains or loses BoomBox Premium.
 *
 * premiumDB is the source of truth for "is this user Premium" (used by
 * boomboxHandler for access checks); the actual Discord role is a visual/
 * perk mirror of that state that we keep in sync best-effort. A failure to
 * grant/revoke the role (missing permission, member left, etc.) must never
 * block the underlying Premium grant/removal -- it's logged and swallowed.
 */

import { IDS } from "../config/ids.js";
import { logger } from "../utils/logger.js";
import { logError } from "../utils/errorLogger.js";

/**
 * @param {import("discord.js").Client} client
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<boolean>} true if the role is now present (or already was)
 */
export async function grantPremiumRole(client, guildId, userId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.has(IDS.PREMIUM_ROLE_ID)) return true;
    await member.roles.add(IDS.PREMIUM_ROLE_ID, "BoomBox Premium granted");
    logger.info(`[Premium] Role granted to ${userId}`);
    return true;
  } catch (e) {
    logger.warn(`[Premium] Failed to grant Premium role to ${userId}: ${e.message}`);
    await logError({
      feature: "Premium",
      reason:  `Failed to grant Premium role: ${e.message}`,
      stage:   "Grant Premium Role",
      user:    userId,
      guild:   guildId,
      error:   e,
    });
    return false;
  }
}

/**
 * @param {import("discord.js").Client} client
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<boolean>} true if the role is now absent (or already was)
 */
export async function revokePremiumRole(client, guildId, userId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.has(IDS.PREMIUM_ROLE_ID)) return true;
    await member.roles.remove(IDS.PREMIUM_ROLE_ID, "BoomBox Premium removed/expired");
    logger.info(`[Premium] Role revoked from ${userId}`);
    return true;
  } catch (e) {
    // Member may have already left the guild -- not an error worth alarming on.
    logger.warn(`[Premium] Failed to revoke Premium role from ${userId}: ${e.message}`);
    await logError({
      feature: "Premium",
      reason:  `Failed to revoke Premium role: ${e.message}`,
      stage:   "Revoke Premium Role",
      user:    userId,
      guild:   guildId,
      error:   e,
    });
    return false;
  }
}
