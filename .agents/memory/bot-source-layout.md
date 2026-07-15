---
name: Bot source layout
description: Where the Discord bot's code lives and how it runs across hosting panels.
---

The bot was moved from `artifacts/keylogger-scanner-bot/` (pnpm-workspace artifact) to the
**repo root** by explicit user request, so it runs identically on Replit, Pterodactyl, Panel
Pedro, and any VPS via `pnpm install && pnpm start` / `node src/index.js` — no workspace or
Replit-specific tooling required.

**Why:** the user wanted a bot that is portable to non-Replit panels without carrying pnpm-workspace
scaffolding (`pnpm-workspace.yaml`, `tsconfig.base.json`, other artifacts) that those panels don't understand.

**How to apply:** repo root now IS the bot (`src/`, `config/`, `data/`, `logs/`, `storage/`, `bin/`,
root `package.json`). There is no `artifacts/` directory anymore — the other two artifacts
(api-server, mockup-sandbox) and all monorepo scaffolding (`pnpm-workspace.yaml`, `lib/`,
`tsconfig*.json`) were deleted along with it. Do not recreate an `artifacts/` structure for this
project unless the user explicitly asks to go back to a multi-artifact monorepo.
