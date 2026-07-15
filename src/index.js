/**
 * src/index.js — Bot entry point.
 *
 * Checks for required secrets. If missing, starts the setup web page and
 * polls until they appear. Once configured, creates the Discord client and
 * registers event handlers from src/events/.
 */

import { Client, GatewayIntentBits, Partials } from "discord.js";
import { getSecretsConfig }    from "../config/bot.js";
import { IDS }                 from "../config/constants.js";
import { logger }              from "./utils/logger.js";
import { logError }            from "./utils/errorLogger.js";
import { startSetupServer }    from "./features/setup/setupServer.js";
import { handleReady }         from "./events/ready.js";
import { handleMessageCreate } from "./events/messageCreate.js";
import { handleInteractionCreate } from "./events/interactionCreate.js";

const SECRETS_POLL_MS = 3000;
const initial = getSecretsConfig();

if (!initial.isConfigured) {
  logger.warn(
    `Secret yang belum diisi: ${initial.missingSecrets.join(", ")}. Menunggu konfigurasi dari halaman setup...`,
  );

  const preferredPort  = Number(process.env.PORT) || 5000;
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
    logger.warn(
      "Semua port kandidat sudah digunakan -- halaman setup tidak tersedia. " +
      "Isi BOT_TOKEN dan SCAN_CHANNEL_ID melalui Secrets pane.",
    );
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

  // Shared mutable state: commands map is populated in clientReady and read by
  // interactionCreate. Using an object reference avoids closure-capture issues.
  const state = { commands: new Map() };

  client.once("clientReady", () => handleReady(client, secrets, state));

  client.on("messageCreate", (message) => handleMessageCreate(message, secrets));

  client.on("interactionCreate", (interaction) =>
    handleInteractionCreate(interaction, state.commands, client),
  );

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
