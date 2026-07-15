# Memory Index

- [Discord gateway bot vs connector](discord-gateway-bot.md) — self-hosted discord.js bots need a raw BOT_TOKEN secret + configureWorkflow console workflow, not the Discord OAuth connector.
- [Keylogger scanner honesty scope](keylogger-scanner-honesty-scope.md) — never fabricate deep analysis (bytecode disassembly, archive extraction) for formats the project has no library for; report the limitation instead.
- [Lua AST analysis pitfalls](lua-ast-analysis-pitfalls.md) — Lua grammar forbids statements after return/break in the same block, so "dead code after return" checks can never fire; use no-break infinite-loop shape instead.
- [BoomBox module architecture](boombox-module.md) — ESM rewrites of ytmp3gg/top4top, all IDs in boomboxConfig.js, JSON-file DB, wired into index.js before scanner guard.
- [Keylogger scanner missing utils](keylogger-scanner-missing-utils.md) — five util files were empty/missing at import time; all fixed; see topic for what each exports.
- [BoomBox anti-bot vs permanent-failure bug](boombox-anti-bot-permanent-failure.md) — error-string substring matching silently aborted YouTube's multi-client fallback loop; watch for classifier keyword overlap.
- [Discord thread component visibility & permission limits](discord-thread-component-visibility.md) — buttons can't be hidden per-viewer in a shared thread, and ephemeral replies need an interaction, not a plain message.
- [Bot source layout](bot-source-layout.md) — all bot code lives in artifacts/keylogger-scanner-bot/; heuristic/ and detectors/ are separate from scanner/ and must both be present.
