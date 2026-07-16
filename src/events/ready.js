/**
 * src/events/ready.js — clientReady event handler.
 * Initialises all persistent services once the bot is logged in.
 */

import { logger }             from "../utils/logger.js";
import { initErrorLogger, logError } from "../utils/errorLogger.js";
import { loadCommands }       from "../commands/index.js";
import { deployCommands }     from "../commands/deploy.js";
import { startPremiumSweep }  from "../features/premium/sweep.js";
import { updatePremStatsDashboard }   from "../features/premium/statsDashboard.js";
import { updateTicketDashboard }      from "../features/ticket/dashboard.js";
import { ticketDB }           from "../database/ticketDB.js";
import { IDS }                from "../../config/constants.js";
import { initBinary }         from "../services/ytmp3gg.js";
import { initConsole, consoleLog }  from "../features/database/console.js";
import { refreshPanelsOnStartup }   from "../features/database/interaction.js";

/**
 * @param {import("discord.js").Client} client
 * @param {{ botToken: string, scanChannelId: string }} secrets
 * @param {{ commands: Map<string,any> }} state  Shared mutable state object
 */
export async function handleReady(client, secrets, state) {
  logger.info(`Login berhasil sebagai ${client.user.tag}`);
  logger.info(`Memantau channel scan: ${secrets.scanChannelId}`);

  initErrorLogger(client);

  // Inisialisasi console logger DATABASE dan kirim log "Bot Online"
  initConsole(client);
  consoleLog("online", "Bot Online", `${client.user.tag} berhasil login dan siap.`).catch(() => {});

  // Pre-download / version-check the yt-dlp binary once at startup so the
  // first BoomBox request doesn't pay a GitHub API round-trip, and concurrent
  // first requests can't race to download the binary simultaneously.
  initBinary().catch((err) => {
    logger.warn(`[BoomBox] yt-dlp binary pre-init failed (non-fatal): ${err.message}`);
  });

  try {
    state.commands = await loadCommands();
    await deployCommands(client, state.commands);
    client._helpCommands = state.commands;
  } catch (err) {
    logger.error("Gagal memuat/mendaftarkan slash command", err);
    await logError({
      feature: "Commands",
      reason:  err?.message ?? String(err),
      stage:   "Startup Registration",
      guild:   IDS.GUILD_ID,
      error:   err,
    }).catch(() => {});
  }

  startPremiumSweep(client);

  // Refresh panel Database yang sudah ada (edit in-place, tidak buat baru).
  // Harus dipanggil setelah bot online agar client.guilds.cache tersedia.
  const guild = client.guilds.cache.get(IDS.GUILD_ID);
  if (guild) {
    refreshPanelsOnStartup(client, guild).catch((err) => {
      logger.warn(`[Database] Startup panel refresh gagal (non-fatal): ${err?.message}`);
    });
  }

  updatePremStatsDashboard(client).catch((err) => {
    logger.warn("PremStats dashboard init failed on startup:", err?.message);
  });

  if (ticketDB.getConfig().logsChannelId) {
    updateTicketDashboard(client).catch((err) => {
      logger.warn("Ticket dashboard init failed on startup:", err?.message);
    });
  }
}
