/**
 * src/events/ready.js — clientReady event handler.
 * Initialises all persistent services once the bot is logged in.
 */

import { logger }             from "../utils/logger.js";
import { initErrorLogger, logError } from "../utils/errorLogger.js";
import { loadCommands }       from "../commands/index.js";
import { deployCommands }     from "../commands/deploy.js";
import { startPremiumSweep }  from "../features/premium/sweep.js";
import { updateMonitoringDashboard }  from "../features/monitoring/dashboard.js";
import { updatePremStatsDashboard }   from "../features/premium/statsDashboard.js";
import { updateTicketDashboard }      from "../features/ticket/dashboard.js";
import { ticketDB }           from "../database/ticketDB.js";
import { IDS }                from "../../config/constants.js";

/**
 * @param {import("discord.js").Client} client
 * @param {{ botToken: string, scanChannelId: string }} secrets
 * @param {{ commands: Map<string,any> }} state  Shared mutable state object
 */
export async function handleReady(client, secrets, state) {
  logger.info(`Login berhasil sebagai ${client.user.tag}`);
  logger.info(`Memantau channel scan: ${secrets.scanChannelId}`);

  initErrorLogger(client);

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

  updateMonitoringDashboard(client).catch((err) => {
    logger.warn("Dashboard init failed on startup:", err?.message);
  });

  updatePremStatsDashboard(client).catch((err) => {
    logger.warn("PremStats dashboard init failed on startup:", err?.message);
  });

  if (ticketDB.getConfig().logsChannelId) {
    updateTicketDashboard(client).catch((err) => {
      logger.warn("Ticket dashboard init failed on startup:", err?.message);
    });
  }
}
