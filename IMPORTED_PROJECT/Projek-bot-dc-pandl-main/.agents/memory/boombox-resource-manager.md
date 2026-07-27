---
name: BoomBox Resource Manager
description: Architecture of the /setup → BoomBox → Resource Manager feature, cookie system hot-reload, and performance improvements made to the pipeline.
---

## Resource Manager

### Entry Point
- Dropdown menu in `/setup → BoomBox → Resource Manager` (value: `"resource"` in `bbsetup:menu:select`)
- CustomId prefix: `bbrm:`
- Routing: `interactionCreate.js` → `handleSetupBoomBoxInteraction` → `handleResourceManagerInteraction`

### Key Files
- `src/features/boombox/setup/resourceManager.js` — UI panels (main, cookies, GIF)
- `src/features/boombox/resourceManagerInteraction.js` — all `bbrm:` interaction logic
- `src/features/boombox/setup/panel.js` — added `"resource"` option to `bbsetup:menu:select` dropdown
- `src/features/boombox/setupInteraction.js` — routes `bbrm:*` to handler, routes `val === "resource"` to panel

## Cookie System

### Storage Architecture
- Managed path: `{PROJECT_ROOT}/cookies.txt` (same path `cookiesResolver.js` already checks)
- Metadata: `data/cookies-meta.json` — stores `{ uploadedAt, source, size }`
- After upload, `reloadCookies()` mutates `COOKIES_ARGS` in-place — all callers see updates immediately

### Hot-Reload
- `COOKIES_ARGS` is exported as a mutable array (not a constant); `reloadCookies()` mutates it in-place
- This works because callers (ytmp3gg.js) spread `COOKIES_ARGS` inside function bodies, not at module load time
- Never reassign `COOKIES_ARGS` — only mutate its contents

### Cookie Upload Methods
1. **File (recommended)**: Owner presses the file button, then sends one `.txt` attachment in the same channel. The bot validates it in memory, atomically saves it, and deletes the source message when permitted.
2. **Paste**: Discord modal → validates Netscape format → saves to `cookies.txt` → `reloadCookies()`
3. **URL**: Downloads in memory (max 2 MB, 15 s timeout) → validates → atomically saves → no URL is retained
4. **Test**: Runs `yt-dlp --simulate` on a known video with cookies; checks output for sign-in errors and stores only sanitized test status

Cookie metadata includes upload time, import method, last-used time, and test status. Cookie contents and sensitive token values are never logged or shown. The shared cookie args are suppressed for TikTok; YouTube and Spotify use the same managed file.

**Why:** Cookies are optional anti-bot assistance. One file covers both YouTube and Spotify. TikTok does not use YouTube cookies.

## GIF Management

- Toggle on/off: `bbrm:gif:enable` / `bbrm:gif:disable` → `db.setDashboard({ showGif: ... })`
- Manage URLs: `bbrm:gif:manage` → delegates to existing `bbdash:gif` panel (no duplication)
- When GIF disabled, BoomBox automatically falls back to plain embed (no code change needed; dashboardEmbed.js already checks `showGif`)

## Performance Improvements

### Periodic Temp Cleanup
- `cleanupStaleBoomBoxTempDirs()` now runs at startup AND every 30 min (unref'd timer in handler.js)
- Cleans: `boombox-*`, `bb-race-ytdlp-*`, `bb-race-ytdlc-*`, `boombox-piped-*`, `boombox-inv-*` in tmpdir

### Disk-Pressure Triggered Cleanup
- `workerManager.js` health check: when disk ≥ 90%, dynamically imports `cleanupStaleBoomBoxTempDirs` and calls it
- Uses dynamic `await import()` to avoid circular import (handler → boomboxQueue → workerManager)

### Async I/O in ytmp3gg.js (hot path)
- `_parseOutput` made `async` — uses `fs.promises.readdir` + `fs.promises.stat`
- Added `_clearTmpDir(dir)` async helper (replaces inline `for/readdirSync/unlinkSync` loops)
- All `fs.mkdtempSync` → `await fs.promises.mkdtemp` (6 locations)
- All hot-path `fs.readdirSync` → `await fs.promises.readdir` (6 locations)
- All hot-path `fs.statSync` → `await fs.promises.stat` (2 locations)
- `.then()` callbacks calling `await _parseOutput` must be marked `async`

**Why:** Sync FS calls block the Node.js event loop, preventing Discord heartbeats and other Promises from processing during those calls. Even short reads accumulate under load.
