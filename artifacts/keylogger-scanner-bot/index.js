import { Client, GatewayIntentBits, Partials } from "discord.js";
import { config, getSecretsConfig } from "./config/config.js";
import { logger } from "./utils/logger.js";
import { initErrorLogger, logError } from "./utils/errorLogger.js";
import { handleAttachmentMessage } from "./scanner/messageHandler.js";
import { handleHesuCommand } from "./scanner/hesuCommand.js";
import { handleScanButtonInteraction } from "./scanner/interactionHandler.js";
import { startSetupServer } from "./config/setupServer.js";
import { handleBoomBoxMessage }    from "./boombox/boomboxHandler.js";
import { handleBoomBoxInteraction } from "./boombox/boomboxInteraction.js";
import { handleBoomBoxLogInteraction } from "./boombox/boomboxLogInteraction.js";
import { loadCommands } from "./commands/index.js";
import { deployCommands } from "./commands/deploy.js";
import { IDS } from "./config/ids.js";
import { startPremiumSweep } from "./boombox/premiumSweep.js";
import { updateMonitoringDashboard } from "./boombox/monitoringDashboard.js";
import { handleMonitoringInteraction } from "./boombox/monitoringInteraction.js";
import { handlePremStatsInteraction } from "./boombox/premStatsInteraction.js";
import { updatePremStatsDashboard } from "./boombox/premStatsDashboard.js";
import { handleTicketThreadMessage } from "./ticket/ticketHandler.js";
import { handleTicketInteraction } from "./ticket/ticketInteraction.js";
import { updateTicketDashboard } from "./ticket/ticketDashboard.js";
import { ticketDB } from "./ticket/ticketDB.js";
import { handleBugReportInteraction } from "./bugreport/bugReportInteraction.js";
import { handleCpanelInteraction } from "./cpanel/cpanelInteraction.js";
import { handleHelpInteraction } from "./commands/help.js";
import { threadDB } from "./thread/threadDB.js";

const SECRETS_POLL_MS = 3000;

const initial = getSecretsConfig();

if (!initial.isConfigured) {
  // Required secrets are missing. Start the dependency-free setup web page
  // so the user can paste BOT_TOKEN/SCAN_CHANNEL_ID without hand-editing
  // files, and poll in the background so the bot starts itself the moment
  // both values become available (via the setup page's Save button, or a
  // Secret added directly) -- no manual restart required. Poll instead of
  // fs.watch: `.env` may not exist yet at all (fs.watch on a missing path
  // throws), and the setup page can be saved multiple times before the
  // values are valid.
  logger.warn(`Secret yang belum diisi: ${initial.missingSecrets.join(", ")}. Menunggu konfigurasi dari halaman setup...`);
  // Try the Replit-assigned PORT first; if it's taken try a few alternatives
  // before giving up. A port conflict must never crash the bot process --
  // the setup page is a convenience, not a hard requirement.
  const preferredPort = Number(process.env.PORT) || 5000;
  const portCandidates = [preferredPort, 5001, 5002, 5003];
  (async () => {
    for (const port of portCandidates) {
      try {
        await startSetupServer(port);
        logger.info(`Halaman setup berjalan di port ${port}. Buka preview untuk mengisi BOT_TOKEN dan SCAN_CHANNEL_ID.`);
        return;
      } catch (err) {
        if (err.code === "EADDRINUSE") {
          logger.warn(`Port ${port} sudah digunakan, mencoba port berikutnya...`);
        } else {
          logger.error("Gagal menjalankan halaman setup", err);
          return;
        }
      }
    }
    logger.warn("Semua port kandidat sudah digunakan -- halaman setup tidak tersedia. Isi BOT_TOKEN dan SCAN_CHANNEL_ID melalui Secrets pane.");
  })();

  const timer = setInterval(() => {
    const current = getSecretsConfig();
    if (current.isConfigured) {
      clearInterval(timer);
      logger.info("BOT_TOKEN dan SCAN_CHANNEL_ID terdeteksi -- menjalankan bot secara otomatis.");
      startBot(current);
    }
  }, SECRETS_POLL_MS);
} else {
  startBot(initial);
}

function startBot(secrets) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  /** @type {Map<string, { data: import("discord.js").SlashCommandBuilder, execute: Function }>} */
  let commands = new Map();

  client.once("clientReady", async () => {
    logger.info(`Login berhasil sebagai ${client.user.tag}`);
    logger.info(`Memantau channel scan: ${secrets.scanChannelId}`);

    // Initialise the global error logger so all features can log to Discord.
    initErrorLogger(client);

    // Load + register slash commands automatically on every startup so the
    // "/" menu and the codebase can never drift out of sync, and no manual
    // deploy step is ever required after a restart.
    try {
      commands = await loadCommands();
      await deployCommands(client, commands);
      // Store commands on client for the help interaction handler
      client._helpCommands = commands;
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

    // Background sweep: revoke the Premium role and log expirations for
    // premium grants/limits that have passed their expiresAt timestamp.
    startPremiumSweep(client);

    // Initialise the monitoring dashboard so it always shows fresh stats
    // on every bot restart (also creates the message on first launch).
    updateMonitoringDashboard(client).catch((err) => {
      logger.warn("Dashboard init failed on startup:", err?.message);
    });

    // Initialise the new Premium Stats dashboard if /premstats has already
    // been configured (channelId stored in premDB). No-op on first launch.
    updatePremStatsDashboard(client).catch((err) => {
      logger.warn("PremStats dashboard init failed on startup:", err?.message);
    });

    // Same for the Ticket Logs dashboard, if /cticket has already been
    // configured in a previous session.
    if (ticketDB.getConfig().logsChannelId) {
      updateTicketDashboard(client).catch((err) => {
        logger.warn("Ticket dashboard init failed on startup:", err?.message);
      });
    }
  });

  // Dedup guard: Discord can occasionally fire messageCreate twice for the
  // same message (e.g. during reconnects with a partial cache). Bound to a
  // small rolling window so it doesn't grow unbounded over a long session.
  const processedMessageIds = new Set();
  const MAX_DEDUP_SIZE = 500;

  client.on("messageCreate", async (message) => {
    try {
      if (message.author?.bot) return;

      // Dedup guard: Discord can fire messageCreate twice for the same message
      // during gateway reconnects. Apply this as the very first check — before
      // !hesu, BoomBox, and the scanner — so ALL three handlers execute at
      // most once per unique message ID. Previously this guard sat after the
      // !hesu early-return, leaving !hesu completely unprotected.
      if (processedMessageIds.has(message.id)) {
        logger.warn(`Duplicate messageCreate for ${message.id} -- ignoring.`);
        return;
      }
      processedMessageIds.add(message.id);
      if (processedMessageIds.size > MAX_DEDUP_SIZE) {
        // Drop the oldest entry (Map/Set preserve insertion order).
        processedMessageIds.delete(processedMessageIds.values().next().value);
      }

      // Auto Thread: silently create "Chat Disini" thread on any new post
      // in a channel where auto-thread is ON. Fire-and-forget — never blocks
      // message processing or the BoomBox/scanner pipelines below.
      if (!message.channel?.isThread() && threadDB.isEnabled(message.channelId)) {
        message.startThread({ name: "Chat Disini", autoArchiveDuration: 60 })
          .catch(() => {});
      }

      // ── Ticket threads: own isolated domain, handled and returned early ──
      // (auto-ack-once for the requester's first message). Threads live on
      // their own channel IDs, so this can never collide with the scanner
      // or BoomBox channels below.
      if (message.channel?.isThread()) {
        await handleTicketThreadMessage(message);
        return;
      }

      // `!hesu` works in any channel, not just the scan channel -- checked
      // before the channel restriction below.
      if (message.content?.trim().toLowerCase() === "!hesu") {
        await handleHesuCommand(message, client);
        return;
      }

      // ── BoomBox: runs on a different channel from the scanner ──────────
      await handleBoomBoxMessage(message);

      if (message.channelId !== secrets.scanChannelId) return; // diamkan channel lain
      if (message.attachments.size === 0) return;

      await handleAttachmentMessage(message);
    } catch (err) {
      // Guard rail of last resort — log to console AND the error channel.
      logger.error("Kesalahan tak terduga saat memproses pesan", err);
      await logError({
        feature: message.channelId === secrets.scanChannelId
          ? "Keylogger Scanner"
          : "Message Handler",
        reason:  err?.message ?? String(err),
        stage:   "messageCreate",
        user:    message.author?.id,
        guild:   message.guildId,
        channel: message.channelId,
        error:   err,
      }).catch(() => {});
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = commands.get(interaction.commandName);
        if (!command) {
          logger.warn(`Slash command tidak dikenal: /${interaction.commandName}`);
          await interaction.reply({ content: "❌ Perintah tidak dikenal.", ephemeral: true }).catch(() => {});
          return;
        }
        await command.execute(interaction, { commands });
        return;
      }

      // Handle buttons, string select menus, and modal submits
      const isBtn    = interaction.isButton();
      const isSelect = interaction.isStringSelectMenu();
      const isModal  = interaction.isModalSubmit();
      if (!isBtn && !isSelect && !isModal) return;

      const id = interaction.customId ?? "";

      if (id.startsWith("ps:")) {
        await handlePremStatsInteraction(interaction, client);
      } else if (id.startsWith("mon:")) {
        await handleMonitoringInteraction(interaction, client);
      } else if (id.startsWith("ticket:")) {
        await handleTicketInteraction(interaction);
      } else if (id.startsWith("bug:")) {
        await handleBugReportInteraction(interaction);
      } else if (isBtn && id.startsWith("bm:")) {
        await handleBoomBoxInteraction(interaction);
      } else if (id.startsWith("bblog:")) {
        await handleBoomBoxLogInteraction(interaction);
      } else if (isBtn && id.startsWith("sk:")) {
        await handleScanButtonInteraction(interaction);
      } else if (id.startsWith("cp:")) {
        await handleCpanelInteraction(interaction);
      } else if (id === "help:category") {
        await handleHelpInteraction(interaction);
      }
    } catch (err) {
      logger.error("Kesalahan tak terduga saat memproses interaksi", err);
      await logError({
        feature: interaction.isChatInputCommand() ? "Commands" : "Interaction",
        command: interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.customId,
        reason:  err?.message ?? String(err),
        stage:   "interactionCreate",
        user:    interaction.user?.id,
        guild:   interaction.guildId,
        channel: interaction.channelId,
        error:   err,
      }).catch(() => {});
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ Terjadi kesalahan saat menjalankan perintah ini.", ephemeral: true }).catch(() => {});
      }
    }
  });

  client.on("error", (err) => {
    logger.error("Discord client error", err);
    logError({
      feature: "Discord Client",
      reason:  err?.message ?? String(err),
      stage:   "Client Error",
      guild:   IDS.GUILD_ID,
      error:   err,
    }).catch(() => {});
  });

  process.on("unhandledRejection", (err) => {
    logger.error("Unhandled promise rejection", err);
    logError({
      feature: "System",
      reason:  err instanceof Error ? err.message : String(err),
      stage:   "Unhandled Rejection",
      error:   err instanceof Error ? err : undefined,
    }).catch(() => {});
  });

  client.login(secrets.botToken).catch((err) => {
    logger.error("Gagal login ke Discord. Periksa BOT_TOKEN.", err);
    process.exit(1);
  });
}

// `config` (static limits) is imported for side-effect-free re-export
// consistency with other scanner modules that import it directly.
void config;
