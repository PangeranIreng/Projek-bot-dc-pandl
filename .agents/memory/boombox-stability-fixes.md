---
name: BoomBox Stability Fixes (Round 2)
description: yt-dlp retry-sleep format fix, provider/timing in logs, provider stats persistence, monitoring panel.
---

# BoomBox Stability Fixes — Round 2

**Why:** Spec required fixing an invalid yt-dlp parameter and adding provider/timing visibility to logs and DB.

## Fix 1: `--retry-sleep exponential=1:2` → `exp=1:2`
- Location: `src/services/ytmp3gg.js` TIKTOK_METHODS method 7
- `exponential=1:2` is NOT a valid yt-dlp retry-sleep expression (produces "invalid http retry sleep expression" warning)
- Correct format: `exp=BASE[:MAX]` — use `exp=1:2` (base=1s, max=2s exponential backoff)
- Other methods use plain integer `"1"` which is always valid

## Fix 2: Provider + timing now in log entries
- `src/features/boombox/handler.js`: added `provider`, `downloadMs`, `uploadMs`, `totalMs` to the history `entry` object
- `downloadMs` and `uploadMs` declared as `let` at top of `runBoomBoxJob` scope (not `const` inside else block)
- `db.incrementStats(platform, ytResult.provider)` — second arg passes provider for persistent tracking
- `db.incrementFailureStats(platform)` called in catch block to track failed conversions

## Fix 3: Provider stats persist across restarts
- `src/database/boomboxDB.js`:
  - Added `byProvider`, `successCount`, `failureCount` to `DEFAULT_DB.statistics`
  - `incrementStats(platform, provider)` — accepts optional provider
  - `incrementFailureStats(platform)` — new method for error tracking
  - `getStatistics()` — returns all fields with safe defaults

## Fix 4: Provider shown in result embed
- `src/features/boombox/embed.js`: `buildResultEmbed` now accepts `downloadMs, uploadMs`
- Footer shows `via yt-dlp #1` (or whichever provider won)
- Timing line: `⬇️ 12.3s ⬆️ 4.1s ⏱ 17.8s` or `⚡ 0.2s (cached)`

## Fix 5: Monitor panel in /setupboombox
- `src/features/boombox/setup/panel.js`:
  - Added 5th "📊 Monitor" button to setup panel ActionRow
  - `buildMonitorEmbed()` — shows provider health, queue snapshot, cache stats, statistics
- `src/features/boombox/setupInteraction.js`: handles `bbsetup:monitor` → shows monitor embed

**How to apply:** Any future provider or timing changes should update the entry fields in handler.js and the embed in embed.js. The `byProvider` stat key matches `ytResult.provider` exactly as returned by ytdl().
