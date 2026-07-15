---
name: Bot source layout
description: Where the Discord bot source code lives after the professional refactor — new structure with src/, config split, events, etc.
---

# Bot source layout (post-refactor)

All bot source is in `artifacts/keylogger-scanner-bot/`. The project uses a professional monorepo-style layout.

## Config (config/)

| File | Contents |
|------|----------|
| `config/bot.js` | `getSecretsConfig()` — reads BOT_TOKEN/SCAN_CHANNEL_ID dynamically |
| `config/channels.js` | All Channel IDs as named exports |
| `config/roles.js` | All Role IDs as named exports |
| `config/owner.js` | `GUILD_ID` + `OWNER_USER_IDS` + `DEVELOPER_USER_IDS` |
| `config/settings.js` | Static scanner limits (`config` export) |
| `config/constants.js` | Re-exports everything + `IDS{}` combined namespace |

**Rule:** Any code that uses `IDS.X` imports `{ IDS }` from `config/constants.js`. New code should import the named constant directly from `channels.js`, `roles.js`, or `owner.js`.

## Source (src/)

```
src/
├── commands/     Slash commands (14 + index.js + deploy.js + help.js re-export)
├── events/       ready.js  messageCreate.js  interactionCreate.js
├── handlers/     messageHandler.js  scanInteractionHandler.js
├── middleware/   permissions.js
├── services/     ytmp3gg  top4top  kaizenDownloader  durationParser
├── utils/        logger  fileUtils  embedBuilder  errorLogger  buttons  etc.
├── database/     All *DB.js files (7 files)
└── features/
    ├── scanner/      19 files (indicators, encryptionDetector, obfuscatorDetector included)
    ├── boombox/      5 files (handler, interaction, embed, config, errorStore)
    ├── monitoring/   dashboard.js  interaction.js
    ├── premium/      log  roleSync  sweep  statsDashboard  statsInteraction
    ├── ticket/       handler  interaction  embed  dashboard  utils
    ├── bugreport/    handler  interaction  embed
    ├── logs/         logDashboard  logInteraction
    ├── queue/        boomboxQueue.js
    ├── help/         handler.js  (src/commands/help.js is a thin re-export)
    └── setup/        setupServer.js + cpanel/embed.js + cpanel/interaction.js
```

## Critical path facts

- **DB files path**: use `path.join(__dirname, "..", "..", "data", "X.json")` — two levels up from `src/database/` to reach the root `data/` dir.
- **setupServer.js path**: uses `path.join(__dirname, "..", "..", "..", ".env")` — three levels up from `src/features/setup/`.
- **Help command**: the actual code is in `src/features/help/handler.js`; `src/commands/help.js` just re-exports `{ data, execute }` so the auto-loader finds it.
- **commands/index.js EXCLUDED_FILES**: `["index.js", "deploy.js"]` — `permissions.js` was removed from this set when it moved to `src/middleware/`.
- **Event sharing**: `index.js` uses `const state = { commands: new Map() }` as a shared mutable object passed to all three event handlers to avoid closure capture issues.

**Why:** The refactor was done to achieve professional project structure per user specification (9-stage plan). All imports are relative; all 90 files pass import verification.
