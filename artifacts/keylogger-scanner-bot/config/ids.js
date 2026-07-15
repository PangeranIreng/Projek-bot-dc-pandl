/**
 * ids.js — Single source of truth for every Discord Channel ID, Role ID,
 * and Guild ID used anywhere in the bot.
 *
 * Do NOT hardcode a Channel/Role/Guild ID literal in any other file.
 * Import `IDS` from here instead. This keeps every module in sync when an
 * ID changes and makes it obvious, in one place, which IDs the bot depends
 * on.
 */

export const IDS = {
  // ── Server ──────────────────────────────────────────────────────────────
  GUILD_ID: "1462696202842931327",

  // ── Channels ────────────────────────────────────────────────────────────
  // Fallback default for the Keylogger Scanner's watched channel -- the
  // *live* value still comes from the SCAN_CHANNEL_ID secret (see
  // config/config.js) so it stays out of source control, but this fallback
  // means the bot has a working default even before a secret is set, and
  // documents the ID in the single ID config file as requested.
  KEYLOGGER_SCAN_CHANNEL_ID: "1524816692943913020",
  BOOMBOX_CHANNEL_ID: "1524817139758792925",
  BOOMBOX_LOG_CHANNEL_ID: "1524811474067919019",
  ERROR_LOG_CHANNEL_ID: "1524811326742855690",
  PREMIUM_DASHBOARD_CHANNEL_ID: "1524810277978247168",

  // ── Roles ───────────────────────────────────────────────────────────────
  OWNER_ROLE_ID: "1462696203241132118",
  DEVELOPER_ROLE_ID: "1462696203241132117",
  PREMIUM_ROLE_ID: "1462696202842931333",
  BOOMBOX_FREE_ROLE_ID: "1525951735879696555",
  MEMBER_ROLE_ID: "1462696202842931329",

  // ── Monitoring ───────────────────────────────────────────────────────────
  // Single-message live dashboard (always edited, never spammed).
  MONITORING_CHANNEL_ID: "1524810922009432144",

  // ── Owner/Developer user IDs ──────────────────────────────────────────────
  // These specific accounts always count as Owner/Developer, even without
  // the matching Discord role (e.g. left the server role temporarily, role
  // misconfigured, etc).
  OWNER_USER_IDS: ["1524067494313328690", "1526142148112551946"],
  DEVELOPER_USER_IDS: ["1516474566044680414"],
};
