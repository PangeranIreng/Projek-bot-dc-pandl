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
import { runBoomBoxLogsMigrationV2 } from "../features/boombox/logs/migration.js";
import { initWorkerManager, setWorkerManagerClient } from "../features/queue/workerManager.js";
import { cleanupStaleBoomBoxTempDirs } from "../features/boombox/handler.js";
import { db } from "../database/db.js";
import { runConfigValidation } from "../utils/configValidator.js";

/**
 * @param {import("discord.js").Client} client
 * @param {{ botToken: string, scanChannelId: string }} secrets
 * @param {{ commands: Map<string,any> }} state  Shared mutable state object
 */
export async function handleReady(client, secrets, state) {
  logger.info(`Login berhasil sebagai ${client.user.tag}`);
  logger.info(`Memantau channel scan: ${secrets.scanChannelId}`);

  // ── Phase 0: Pre-checks & cleanup ──────────────────────────────────────────

  // Initialize error logger first so subsequent errors can be posted to Discord.
  initErrorLogger(client);

  // Inisialisasi console logger DATABASE dan kirim log "Bot Online"
  initConsole(client);
  consoleLog("online", "Bot Online", `${client.user.tag} berhasil login dan siap.`).catch(() => {});

  // Clean up any stale BoomBox temp directories left behind by a previous crash
  // or SIGKILL that prevented the normal finally-block cleanup from running.
  cleanupStaleBoomBoxTempDirs();

  // Pre-download / version-check the yt-dlp binary once at startup so the
  // first BoomBox request doesn't pay a GitHub API round-trip, and concurrent
  // first requests can't race to download the binary simultaneously.
  initBinary().catch((err) => {
    logger.warn(`[BoomBox] yt-dlp binary pre-init failed (non-fatal): ${err.message}`);
  });

  // ── Phase 1: Commands ───────────────────────────────────────────────────────

  let commandsLoaded = false;
  try {
    state.commands = await loadCommands();
    await deployCommands(client, state.commands);
    client._helpCommands = state.commands;
    commandsLoaded = true;
    logger.info(`[Startup] ✔ Commands: ${state.commands.size} command(s) dimuat`);
  } catch (err) {
    logger.error("[Startup] ✘ Commands: gagal memuat/mendaftarkan slash command", err);
    logError({
      feature: "Commands",
      reason:  err?.message ?? String(err),
      stage:   "Startup Registration",
      guild:   IDS.GUILD_ID,
      error:   err,
    }).catch(() => {});
  }

  // ── Phase 2: Worker Manager ────────────────────────────────────────────────

  let workersInitialized = false;
  try {
    initWorkerManager(db);
    setWorkerManagerClient(client);
    workersInitialized = true;
    logger.info("[Startup] ✔ WorkerManager: semua worker aktif");
  } catch (err) {
    logger.error(`[Startup] ✘ WorkerManager: init gagal (non-fatal): ${err?.message}`);
    logError({
      feature: "WorkerManager",
      reason:  err?.message ?? String(err),
      stage:   "Startup Init",
      error:   err,
    }).catch(() => {});
  }

  // ── Phase 3: Background services ──────────────────────────────────────────

  // Premium expiration sweep
  try {
    startPremiumSweep(client);
    logger.info("[Startup] ✔ Premium sweep: dimulai");
  } catch (err) {
    logger.error(`[Startup] ✘ Premium sweep: gagal start (non-fatal): ${err?.message}`);
  }

  // Database panels refresh (edit in-place, tidak buat baru).
  // Harus dipanggil setelah bot online agar client.guilds.cache tersedia.
  const guild = client.guilds.cache.get(IDS.GUILD_ID);
  if (guild) {
    refreshPanelsOnStartup(client, guild).catch((err) => {
      logger.warn(`[Startup] Database panel refresh gagal (non-fatal): ${err?.message}`);
    });
  } else {
    logger.warn(`[Startup] Guild ${IDS.GUILD_ID} tidak ditemukan di cache — panel refresh dilewati`);
  }

  // Premium stats dashboard
  updatePremStatsDashboard(client).catch((err) => {
    logger.warn(`[Startup] PremStats dashboard init gagal (non-fatal): ${err?.message}`);
  });

  // Ticket dashboard
  if (ticketDB.getConfig().logsChannelId) {
    updateTicketDashboard(client).catch((err) => {
      logger.warn(`[Startup] Ticket dashboard init gagal (non-fatal): ${err?.message}`);
    });
  }

  // BoomBox Logs V2 — one-time migration (idempotent, skips if already done)
  runBoomBoxLogsMigrationV2(client).catch((err) => {
    logger.warn(`[Startup] BoomBox Migration V2 gagal (non-fatal): ${err?.message}`);
  });

  // Config validation — verify all /setup-configured channels and roles still
  // exist in Discord. Logs clear warnings and notifies via DATABASE console if
  // any were deleted while the bot was offline. Non-fatal — bot continues normally.
  runConfigValidation(client).catch((err) => {
    logger.warn(`[Startup] Config validation gagal (non-fatal): ${err?.message}`);
  });

  // ── Startup summary ────────────────────────────────────────────────────────

  const summary = [
    commandsLoaded      ? `✔ Commands (${state.commands.size})`   : "✘ Commands (load error)",
    workersInitialized  ? "✔ WorkerManager"                        : "✘ WorkerManager (init error)",
    "✔ Premium Sweep",
    "✔ Error Logger",
    guild               ? "✔ Guild Cache"                          : "✘ Guild Cache (not found)",
  ];
  logger.info(`[Startup] Bot siap.\n  ${summary.join("\n  ")}`);
}
