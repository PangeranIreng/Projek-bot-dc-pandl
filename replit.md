# Keylogger Scanner Bot

A Discord bot (discord.js v14) that automatically scans file attachments posted in a designated channel and reports a cautious, heuristic threat assessment. Also bundles a BoomBox music module, a ticket system, a bug report system, and a CPanel (role-button panel) system for the same Discord server.

## Run & Operate

- `pnpm --filter @workspace/keylogger-scanner-bot run dev` — run the bot (bound to the "Keylogger Scanner Bot" workflow)
- Required secrets: `BOT_TOKEN` (Discord bot token from the Discord Developer Portal)
- Optional: `SCAN_CHANNEL_ID` — defaults to the value in `config/channels.js`

## Stack

- pnpm workspaces, Node.js 24
- Discord bot: discord.js v14, ESM (`"type": "module"`)
- Lua parsing: luaparse; ZIP handling: adm-zip; media: @distube/ytdl-core, axios, form-data

## Structure (post-refactor)

```
artifacts/keylogger-scanner-bot/
├── index.js              Entry point — startup, Discord client, delegates to src/events/
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
│       ├── monitoring/   Monitoring dashboard
│       ├── premium/      Premium management (log, roleSync, sweep, statsDashboard)
│       ├── ticket/       Ticket system (handler, interaction, embed, dashboard)
│       ├── bugreport/    Bug report & feature request system
│       ├── logs/         BoomBox log dashboard
│       ├── queue/        BoomBox queue (max 5 concurrent)
│       ├── help/         Help command handler
│       └── setup/        Setup page + CPanel role-button panels
├── data/                 Flat JSON databases (boombox-db, premium-db, ticket-db, etc.)
├── storage/              downloads/, cache/, temp/, backup/
├── logs/
└── scripts/
```

## Architecture Decisions

- **All IDs in config/**: Channel IDs → channels.js; Role IDs → roles.js; Guild + owner IDs → owner.js. `config/constants.js` re-exports everything as named exports AND as the `IDS{}` combined object for backward compat.
- **Events extracted**: clientReady/messageCreate/interactionCreate live in `src/events/` — index.js is a clean 80-line entry point.
- **Database layer**: All `*DB.js` files are in `src/database/`. They access `data/` via `path.join(__dirname, "..", "..", "data", ...)` (two levels up from `src/database/`).
- **Setup server path**: `src/features/setup/setupServer.js` accesses `.env` via `path.join(__dirname, "..", "..", "..", ".env")` (three levels up).
- **Help command**: `src/features/help/handler.js` has the implementation; `src/commands/help.js` is a thin re-export so the command auto-loader picks it up.
- No external database — flat JSON files in `data/` are intentional and survive restarts.
- `config/constants.js` exports `IDS` for any code that uses the combined namespace.

## User preferences

_None recorded yet._

## Gotchas

- All Channel/Role/Guild IDs must live in `config/channels.js`, `config/roles.js`, or `config/owner.js`. Never hardcode an ID elsewhere.
- When adding a new slash command: drop a new file in `src/commands/` that exports `{ data, execute }`. The auto-loader picks it up on next start — no registration step needed.
- `src/database/db.js` exports shared BoomBoxDB and PremiumDB singletons — import from there, never `new BoomBoxDB()` directly.
- Run `pnpm install` inside `artifacts/keylogger-scanner-bot/` after a fresh clone — `node_modules` is not checked in.
