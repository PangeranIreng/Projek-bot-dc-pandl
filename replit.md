# Keylogger Scanner Bot

A Discord bot (discord.js v14) that automatically scans file attachments posted in a designated channel and reports a cautious, heuristic threat assessment. Also bundles a BoomBox music module, a ticket system, a bug report system, and a CPanel (role-button panel) system for the same Discord server.

This is a **standalone repo-root project** — not a pnpm-workspace monorepo. It runs identically on Replit, Pterodactyl, Panel Pedro, or any plain VPS via `pnpm install && pnpm start` (or `npm install && npm start`, or `node src/index.js` directly).

## Run & Operate

- `pnpm start` (or `node src/index.js`) — run the bot (bound to the "Keylogger Scanner Bot" workflow on Replit)
- Required secret: `BOT_TOKEN` (Discord bot token from the Discord Developer Portal)
- Optional: `SCAN_CHANNEL_ID` — defaults to the value in `config/channels.js`
- On other panels (Pterodactyl/Pedro/VPS): copy `.env.example` to `.env` and fill in `BOT_TOKEN` (and optionally `SCAN_CHANNEL_ID`), then run `pnpm install && pnpm start`
- If secrets are missing, the bot serves a one-time setup web page (writes to `.env`) instead of crashing

## Stack

- Plain Node.js package (no workspace), Node.js 20+, ESM (`"type": "module"`)
- Discord bot: discord.js v14
- Lua parsing: luaparse; ZIP handling: adm-zip; media: @distube/ytdl-core, axios, form-data

## Structure

```
/ (repo root)
├── src/index.js          Entry point — startup, Discord client, delegates to src/events/
├── config/
│   ├── bot.js            getSecretsConfig() — reads BOT_TOKEN/SCAN_CHANNEL_ID
│   ├── channels.js       All Channel IDs
│   ├── roles.js          All Role IDs
│   ├── owner.js          GUILD_ID + owner/developer user IDs
│   ├── settings.js       Static scanner limits (file sizes, extensions)
│   └── constants.js      Re-exports everything + IDS{} combined object
├── src/
│   ├── commands/         Slash commands (14 files + index.js + deploy.js + help re-export)
│   ├── events/           ready.js, messageCreate.js, interactionCreate.js
│   ├── handlers/         messageHandler.js, scanInteractionHandler.js
│   ├── middleware/        permissions.js (isStaff, isOwner, denyIfNotStaff)
│   ├── services/         ytmp3gg, top4top, kaizenDownloader, durationParser
│   ├── utils/            logger, fileUtils, embedBuilder, errorLogger, buttons, etc.
│   ├── database/         All *DB.js files (boomboxDB, premiumDB, ticketDB, etc.)
│   └── features/
│       ├── scanner/      Scan engine (19 files: decoder, heuristic, riskScore, etc.)
│       ├── boombox/      BoomBox feature (handler, interaction, embed, config)
│       ├── premium/      Premium management (log, roleSync, sweep, statsDashboard — single source of truth for the premium/limit dashboard)
│       ├── ticket/       Ticket system (handler, interaction, embed, dashboard)
│       ├── bugreport/    Bug report & feature request system
│       ├── logs/         BoomBox log dashboard
│       ├── queue/        BoomBox queue (max 5 concurrent, with a 10-minute per-job timeout)
│       ├── help/         Help command handler
│       └── setup/        Setup page + CPanel role-button panels
├── data/                 Flat JSON databases (boombox-db, premium-db, ticket-db, etc.)
├── storage/              downloads/, cache/, temp/, backup/
├── logs/
├── bin/                  yt-dlp binaries
└── scripts/post-merge.sh
```

## Architecture Decisions

- **All IDs in config/**: Channel IDs → channels.js; Role IDs → roles.js; Guild + owner IDs → owner.js. `config/constants.js` re-exports everything as named exports AND as the `IDS{}` combined object for backward compat.
- **Events extracted**: clientReady/messageCreate/interactionCreate live in `src/events/` — `src/index.js` is a clean entry point.
- **Database layer**: All `*DB.js` files are in `src/database/`. They access `data/` via `path.join(__dirname, "..", "..", "data", ...)` (two levels up from `src/database/`).
- **Setup server path**: `src/features/setup/setupServer.js` accesses `.env` via `path.join(__dirname, "..", "..", "..", ".env")` (three levels up).
- **Help command**: `src/features/help/handler.js` has the implementation; `src/commands/help.js` is a thin re-export so the command auto-loader picks it up.
- No external database — flat JSON files in `data/` are intentional and survive restarts.
- **One premium/limit dashboard, not two**: `features/premium/statsDashboard.js` (the `ps:` custom-id namespace, driven by `/premstats`) is the only monitoring panel. An older, functionally-duplicate `features/monitoring/dashboard.js` (`mon:` namespace) was removed — both used to run side by side and get updated from the exact same call sites, producing two near-identical live panels in the channel. If an old "mon:" panel message is still visible in a channel, delete it manually; its buttons no longer respond.
- **BoomBox queue never gets permanently stuck**: `features/queue/boomboxQueue.js` races every job against a 10-minute timeout. If a download hangs (network stall, dead host), the queue slot is freed and the failure is reported to Error Logs instead of silently occupying one of the 5 concurrency slots forever.

## User preferences

_None recorded yet._

## Gotchas

- All Channel/Role/Guild IDs must live in `config/channels.js`, `config/roles.js`, or `config/owner.js`. Never hardcode an ID elsewhere.
- When adding a new slash command: drop a new file in `src/commands/` that exports `{ data, execute }`. The auto-loader picks it up on next start — no registration step needed.
- `src/database/db.js` exports shared BoomBoxDB and PremiumDB singletons — import from there, never `new BoomBoxDB()` directly.
- Run `pnpm install` (or `npm install`) at the repo root after a fresh clone — `node_modules` is not checked in.
- Do not reintroduce a second premium/limit dashboard — extend `features/premium/statsDashboard.js` instead of adding a parallel panel.
