---
name: Bot source layout
description: Where the Discord bot source code lives and which subdirectories are required.
---

# Bot source layout

All bot source code lives under `artifacts/keylogger-scanner-bot/` as a pnpm workspace package (`@workspace/keylogger-scanner-bot`).

**Required subdirectories** (all must be present — missing any causes Module Not Found errors):

| Dir | What it contains |
|-----|-----------------|
| `config/` | config.js, ids.js, setupServer.js |
| `scanner/` | core scanning engine (14 files) |
| `heuristic/` | indicators.js — regex indicator catalog imported by scanner/hesuCommand.js |
| `detectors/` | obfuscatorDetector.js, encryptionDetector.js — imported by scanner files |
| `boombox/` | BoomBox music module (24 files incl. ytmp3gg, top4top, kaizenDownloader, queue, DBs) |
| `commands/` | slash commands + deploy.js + permissions.js |
| `ticket/` | ticket lifecycle (6 files) |
| `bugreport/` | bug report system (4 files) |
| `cpanel/` | interactive role-button panels (3 files) |
| `thread/` | auto-thread system (threadDB.js) |
| `utils/` | shared helpers (7 files: logger, embedBuilder, errorLogger, etc.) |
| `data/` | flat JSON databases (6 files, must exist with default `{}` content) |
| `bin/` | yt-dlp binary executables |

**Why:** `heuristic/` and `detectors/` are sibling directories of `scanner/`, not inside it. `scanner/hesuCommand.js` imports from `../heuristic/indicators.js` and `../detectors/obfuscatorDetector.js`. Copying only `scanner/` without these two causes immediate startup crashes.

**Entry point:** `index.js` at `artifacts/keylogger-scanner-bot/index.js`.

**Run command:** `pnpm --filter @workspace/keylogger-scanner-bot run dev`
