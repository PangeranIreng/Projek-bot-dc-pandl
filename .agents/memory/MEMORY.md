# Memory Index

- [Lua Tools Architecture](luatools-architecture.md) — file layout, DB singleton, interaction prefix `ltsetup:`, and API env vars for the Lua Tools feature.

- [DATABASE system](database-system.md) — arsitektur sistem DATABASE baru: 7 file baru, prefix `db:`, setup flow, panel Bot Setting/Backup/Console/Member List.

- [Discord gateway bot vs connector](discord-gateway-bot.md) — self-hosted discord.js bots need a raw BOT_TOKEN secret + configureWorkflow console workflow, not the Discord OAuth connector.
- [Keylogger scanner honesty scope](keylogger-scanner-honesty-scope.md) — never fabricate deep analysis (bytecode disassembly, archive extraction) for formats the project has no library for; report the limitation instead.
- [Lua AST analysis pitfalls](lua-ast-analysis-pitfalls.md) — Lua grammar forbids statements after return/break in the same block, so "dead code after return" checks can never fire; use no-break infinite-loop shape instead.
- [BoomBox module architecture](boombox-module.md) — ESM rewrites of ytmp3gg/top4top, all IDs in boomboxConfig.js, JSON-file DB, wired into index.js before scanner guard.
- [Keylogger scanner missing utils](keylogger-scanner-missing-utils.md) — five util files were empty/missing at import time; all fixed; see topic for what each exports.
- [BoomBox anti-bot vs permanent-failure bug](boombox-anti-bot-permanent-failure.md) — error-string substring matching silently aborted YouTube's multi-client fallback loop; watch for classifier keyword overlap.
- [Discord thread component visibility & permission limits](discord-thread-component-visibility.md) — buttons can't be hidden per-viewer in a shared thread, and ephemeral replies need an interaction, not a plain message.
- [Bot source layout](bot-source-layout.md) — bot code lives at the repo root (no artifacts/ dir), runs via `pnpm start`/`node src/index.js` on any panel.
- [Duplicate premium dashboard removed](premium-dashboard-consolidation.md) — two near-identical monitoring panels ran side by side from identical call sites; kept statsDashboard.js only.
- [BoomBox "Analyzing" stage hang](boombox-analyzing-stage-hang.md) — unbounded https.get in ensureBinary() could freeze jobs forever; layer idle timeouts per-request AND per-stage.
- [BoomBox stability fixes](boombox-stability-fixes.md) — 5 root-cause bugs fixed: timeout=permanent (broke fallback), per-request GitHub API in ensureBinary, no AbortController (zombie yt-dlp), getVideoInfo ignoring health, top4top stream leak.
- [BoomBox binary path bug](boombox-binary-path-bug.md) — BIN_DIR used one ".." (→ src/bin/) instead of two (→ bin/); caused every request to attempt a 30s GitHub download, producing the "Analyzing Link..." stuck embed.
- [BoomBox ffmpeg resolution](boombox-ffmpeg-resolution.md) — ffmpeg resolved via shared src/utils/ffmpegPath.js (system→ffmpeg-static); nixpacks.toml keeps system ffmpeg as preferred on Railway; kaizenDownloader skips transcode when CDN already delivers target format.
- [BoomBox cross-platform binary](boombox-cross-platform-binary.md) — yt-dlp: system PATH first (_USE_SYSTEM_YTDLP, no download), then bin/yt-dlp_{suffix}, then bin/yt-dlp; platform suffix auto-detected; cookies via cookiesResolver.js; env detected via envDetector.js.
