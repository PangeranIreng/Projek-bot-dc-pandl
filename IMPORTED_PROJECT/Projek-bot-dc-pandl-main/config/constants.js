/**
 * config/constants.js — Unified re-export of all Discord IDs.
 *
 * Import individual constants from channels.js / roles.js / owner.js when
 * you only need one category. Import `IDS` from here when you need a
 * combined namespace (for backward compatibility).
 */

export * from "./channels.js";
export * from "./roles.js";
export * from "./owner.js";

import {
  KEYLOGGER_SCAN_CHANNEL_ID, BOOMBOX_CHANNEL_ID, BOOMBOX_LOG_CHANNEL_ID,
  ERROR_LOG_CHANNEL_ID, PREMIUM_DASHBOARD_CHANNEL_ID, MONITORING_CHANNEL_ID,
} from "./channels.js";
import {
  OWNER_ROLE_ID, DEVELOPER_ROLE_ID, PREMIUM_ROLE_ID,
  BOOMBOX_FREE_ROLE_ID, MEMBER_ROLE_ID,
} from "./roles.js";
import { GUILD_ID, OWNER_USER_IDS, DEVELOPER_USER_IDS } from "./owner.js";

/** Combined namespace for files that need multiple ID categories at once. */
export const IDS = {
  GUILD_ID,
  KEYLOGGER_SCAN_CHANNEL_ID,
  BOOMBOX_CHANNEL_ID,
  BOOMBOX_LOG_CHANNEL_ID,
  ERROR_LOG_CHANNEL_ID,
  PREMIUM_DASHBOARD_CHANNEL_ID,
  MONITORING_CHANNEL_ID,
  OWNER_ROLE_ID,
  DEVELOPER_ROLE_ID,
  PREMIUM_ROLE_ID,
  BOOMBOX_FREE_ROLE_ID,
  MEMBER_ROLE_ID,
  OWNER_USER_IDS,
  DEVELOPER_USER_IDS,
};
