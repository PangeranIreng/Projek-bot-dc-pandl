/**
 * permissions.js — Shared authorization check for admin-only slash
 * commands (/addprem, /removeprem, /setlimit, /resetlimit).
 */

import { IDS } from "../config/ids.js";

const STAFF_ROLE_IDS = [IDS.OWNER_ROLE_ID, IDS.DEVELOPER_ROLE_ID];
const STAFF_USER_IDS = [...IDS.OWNER_USER_IDS, ...IDS.DEVELOPER_USER_IDS];

/**
 * True for the Owner/Developer roles, OR the hardcoded Owner/Developer user
 * IDs (config/ids.js) -- those specific accounts always count as staff even
 * without the matching Discord role.
 * @param {import("discord.js").GuildMember | null} member
 */
export function isStaff(member) {
  if (!member) return false;
  if (STAFF_USER_IDS.includes(member.id)) return true;
  return member.roles.cache.some((r) => STAFF_ROLE_IDS.includes(r.id));
}

/** True if this user ID is one of the always-Owner accounts. */
export function isOwnerUser(userId) {
  return IDS.OWNER_USER_IDS.includes(userId);
}

/**
 * True for the Owner role, OR one of the hardcoded Owner user IDs.
 * Stricter than isStaff() — excludes Developer. Use for commands that must
 * be Owner-only (e.g. /cbug).
 * @param {import("discord.js").GuildMember | null} member
 */
export function isOwner(member) {
  if (!member) return false;
  if (isOwnerUser(member.id)) return true;
  return member.roles.cache.has(IDS.OWNER_ROLE_ID);
}

/**
 * Reply with a permission-denied message and return true if the
 * interaction's member is not Owner. Call and
 * `if (await denyIfNotOwner(interaction)) return;` at the top of any
 * Owner-only command's execute().
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function denyIfNotOwner(interaction) {
  if (isOwner(interaction.member)) return false;
  await interaction.reply({
    content: "❌ Hanya Owner yang dapat menggunakan command ini.",
    ephemeral: true,
  });
  return true;
}

/** True if this user ID is one of the always-Developer accounts. */
export function isDeveloperUser(userId) {
  return IDS.DEVELOPER_USER_IDS.includes(userId);
}

/**
 * Reply with a permission-denied message and return true if the
 * interaction's member is not staff. Call and `if (await denyIfNotStaff(interaction)) return;`
 * at the top of every admin command's execute().
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function denyIfNotStaff(interaction) {
  if (isStaff(interaction.member)) return false;
  await interaction.reply({
    content: "❌ Kamu tidak memiliki izin menggunakan command ini.",
    ephemeral: true,
  });
  return true;
}
