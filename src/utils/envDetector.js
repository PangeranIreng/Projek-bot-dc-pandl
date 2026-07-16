/**
 * envDetector.js — Detect the hosting environment at startup.
 *
 * Used for context-aware logging. Does NOT gate any feature — the bot runs
 * identically on all platforms; this is informational only.
 *
 * Exports:
 *   ENV_NAME   string   "Railway" | "Replit" | "Pterodactyl" | "Linux VPS" | "Unknown"
 *   ENV_INFO   object   { name, platform, arch, node }
 */

function _detect() {
  const env = process.env;

  // Railway — sets RAILWAY_ENVIRONMENT or RAILWAY_PROJECT_ID
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_NAME) {
    return "Railway";
  }
  // Replit — sets REPL_ID or REPLIT_DB_URL
  if (env.REPL_ID || env.REPLIT_DB_URL || env.REPL_SLUG) {
    return "Replit";
  }
  // Pterodactyl / Pyrodele — sets P_SERVER_UUID or PTERODACTYL_*
  if (env.P_SERVER_UUID || env.PTERODACTYL_BOOT_COMMAND || env.P_SERVER_LOCATION) {
    return "Pterodactyl";
  }
  // GitHub Actions / CI
  if (env.GITHUB_ACTIONS || env.CI) {
    return "CI";
  }
  // Render
  if (env.RENDER || env.RENDER_SERVICE_ID) {
    return "Render";
  }
  // Generic Linux VPS
  if (process.platform === "linux") {
    return "Linux VPS";
  }
  return "Unknown";
}

export const ENV_NAME = _detect();
export const ENV_INFO = {
  name:     ENV_NAME,
  platform: process.platform,
  arch:     process.arch,
  node:     process.version,
};
