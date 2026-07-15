# Keylogger Scanner Bot

A Discord bot (discord.js v14) that automatically scans file attachments posted in a designated channel and reports a cautious, heuristic threat assessment. Also bundles a BoomBox music module, a ticket system, a bug report system, and a CPanel (role-button panel) system for the same Discord server.

## Run & Operate

- `pnpm --filter @workspace/keylogger-scanner-bot run dev` — run the bot (bound to the "Keylogger Scanner Bot" workflow)
- Required secrets: `BOT_TOKEN` (Discord bot token from the Discord Developer Portal)
- Config: `artifacts/keylogger-scanner-bot/.env.example` documents `SCAN_CHANNEL_ID` and other env vars; see `artifacts/keylogger-scanner-bot/config/config.js` and `config/ids.js`

## Stack

- pnpm workspaces, Node.js 24
- Discord bot: discord.js v14, ESM (`"type": "module"`)
- Lua parsing: luaparse; ZIP handling: adm-zip; media: @distube/ytdl-core, axios, form-data

## Where things live

- `artifacts/keylogger-scanner-bot/index.js` — Bot entry point: Discord client + message/interaction listeners
- `artifacts/keylogger-scanner-bot/config/` — config.js (env/secrets loading), ids.js (single source of truth for all Discord IDs), setupServer.js (setup web page when BOT_TOKEN is missing)
- `artifacts/keylogger-scanner-bot/scanner/` — file-scanning/deobfuscation engine (detector, parser, decoder, deobfuscator, riskScore, scorer, report, hesuCommand, messageHandler, interactionHandler)
- `artifacts/keylogger-scanner-bot/heuristic/` — indicators.js (regex-based indicator catalog used by scanner)
- `artifacts/keylogger-scanner-bot/detectors/` — obfuscatorDetector.js, encryptionDetector.js (named signature/cipher detection)
- `artifacts/keylogger-scanner-bot/boombox/` — music/BoomBox module (ytmp3gg, top4top, kaizenDownloader, queue, DB, premium role sync, monitoring/premstats dashboards)
- `artifacts/keylogger-scanner-bot/ticket/` — ticket system (handler, DB, embed, interaction, dashboard)
- `artifacts/keylogger-scanner-bot/bugreport/` — bug report & feature request system
- `artifacts/keylogger-scanner-bot/cpanel/` — CPanel interactive role-button panels
- `artifacts/keylogger-scanner-bot/thread/` — Auto Thread system (per-channel thread creation)
- `artifacts/keylogger-scanner-bot/commands/` — slash commands (addprem, removeprem, setlimit, resetlimit, cticket, cbug, cpanel, thread, help, etc.) + deploy.js + permissions.js
- `artifacts/keylogger-scanner-bot/utils/` — shared utilities (logger, embedBuilder, errorLogger, reportBuilder, buttons, fileUtils, fullPreviewEmbed)
- `artifacts/keylogger-scanner-bot/data/*.json` — flat-file JSON databases (no external DB)
- `artifacts/keylogger-scanner-bot/bin/` — yt-dlp binary (used by ytmp3gg.js)
- Other workspace packages (`lib/api-server`, `lib/api-spec`, etc.) are unused scaffolding from the pnpm-workspace template, not part of this bot

## Architecture decisions

- No slash-command-driven scanning: file scanning is fully automatic in `SCAN_CHANNEL_ID`, silent everywhere else (except `!hesu` status command).
- The scanner never fabricates results it can't produce (e.g. RAR/7z/EXE bytecode decompilation) — reports "limited analysis" instead of a fake verdict.
- Persistence uses flat JSON files per subsystem in `data/` rather than a real database — matches the bot's original design; not migrated.
- All Discord Channel/Role/Guild IDs live exclusively in `config/ids.js` — never hardcoded elsewhere.
- `boombox/db.js` exports shared BoomBoxDB and PremiumDB singletons — import from here, never `new BoomBoxDB()` directly, to avoid divergent in-memory caches.

## Product

- **Scanner**: Auto-scans uploaded files for keylogger/malware indicators and posts a threat-assessment embed with Full Preview / Download / Copy Webhook / Copy Indicators / Scan Again buttons.
- **BoomBox**: Converts YouTube/TikTok links to top4top-hosted audio URLs. Bounded-concurrency FIFO queue (max 5 concurrent); overflow waits with private DM queue notice.
- **Ticket system**: Open/Claim/Close/Transcript workflow with private threads. Staff Controls (Claim/Close/Transcript/Delete buttons) live in a dedicated staff-only channel.
- **Bug report system**: Panel-based Bug Report & Feature Request submission.
- **CPanel**: Slash-command-driven interactive panels with configurable role-toggle buttons.
- **Auto Thread**: Per-channel automatic thread creation on every new post.

## User preferences

_None recorded yet._

## Gotchas

- Run `pnpm install` inside `artifacts/keylogger-scanner-bot` after a fresh import/clone — `node_modules` is not checked in.
- This project does not use the monorepo's `api-server`/`db`/Postgres stack at all; ignore those packages when working on the bot.
- All IDs must be defined in `config/ids.js` — never hardcode a Channel/Role/Guild ID anywhere else.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `.agents/memory/` topic files for BoomBox architecture, the anti-bot/permanent-failure bug fix, and Lua AST analysis pitfalls
