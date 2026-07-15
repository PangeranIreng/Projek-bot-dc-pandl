/**
 * boomboxConfig.js — BoomBox-specific constants. All Channel/Role/Guild IDs
 * live in `config/ids.js` (the single source of truth) and are re-exported
 * here for convenience -- never redefine an ID literal in this file.
 */

import { IDS } from "../config/ids.js";

export const BOOMBOX_CONFIG = {
  // Server
  GUILD_ID: IDS.GUILD_ID,

  // Channels
  BOOMBOX_CHANNEL_ID:     IDS.BOOMBOX_CHANNEL_ID,
  BOOMBOX_LOG_CHANNEL_ID: IDS.BOOMBOX_LOG_CHANNEL_ID,

  // Roles
  OWNER_ROLE_ID:     IDS.OWNER_ROLE_ID,
  DEVELOPER_ROLE_ID: IDS.DEVELOPER_ROLE_ID,
  PREMIUM_ROLE_ID:   IDS.PREMIUM_ROLE_ID,
  BOOMBOX_FREE_ROLE_ID: IDS.BOOMBOX_FREE_ROLE_ID,
  MEMBER_ROLE_ID:    IDS.MEMBER_ROLE_ID,

  // Conversion defaults
  AUDIO_TYPE:    "mp3",
  AUDIO_QUALITY: "128", // kbps

  // Default daily request limit for BoomBox Free role
  DEFAULT_FREE_DAILY_LIMIT: 10,
};

/** Roles that have unlimited BoomBox access. */
export const UNLIMITED_ROLES = [
  BOOMBOX_CONFIG.OWNER_ROLE_ID,
  BOOMBOX_CONFIG.DEVELOPER_ROLE_ID,
  BOOMBOX_CONFIG.PREMIUM_ROLE_ID,
];

/** All roles allowed to use BoomBox at all. */
export const ALLOWED_ROLES = [
  ...UNLIMITED_ROLES,
  BOOMBOX_CONFIG.BOOMBOX_FREE_ROLE_ID,
];
