---
name: BoomBox HA & Self Recovery
description: Gaps found and fixes applied during the High Availability audit — worker watchdog, circuit breakers, disk monitoring.
---

## Worker Stall Detection
- Old check (`active > 0 && queued > 50`) was a proxy metric that mis-classified busy-but-healthy workers as stalled.
- Fix: `PlatformWorker.lastActivityAt` (epoch ms) updated on every job start and every job completion; exposed in `getSnapshot()`.
- Health check computes per-worker stall threshold: `timeoutMs > 0 ? timeoutMs × 3 : 20_min`. BoomBox workers (`timeoutMs=0`) use 20 min (their stage guards run up to 15 min max).
- On confirmed stall, health check now calls `w.restart()` and logs the action — no more "log only, no action".

## Circuit Breakers Extended
- `providerHealth.js` already covered yt-dlp-youtube, yt-dlp-tiktok, ytdl-core, kaizenapi.
- Added: `"top4top"` (uploader) and `"spotify-oembed"` — both labels added to `PROVIDER_LABELS`.
- **`top4top.js`**: checks `shouldSkip('top4top')` before retry loop; calls `recordSuccess`/`recordFailure` on each outcome; throws `CIRCUIT_OPEN` error when open.
- **`spotifyResolver.js`**: checks `shouldSkip('spotify-oembed')` before oEmbed fetch; falls back to trackId query immediately when circuit is open; calls `recordSuccess`/`recordFailure` in retry loop.

## Disk Space Monitoring
- `DISK_WARN_THRESHOLD = 0.90` added to `workerConfig.js`.
- Health check uses `fs.promises.statfs(os.tmpdir())` (Node 20+) — gracefully skips if not available.
- Logs a warning + includes in `logError` report when disk ≥ 90% used.

## Key invariants to maintain
- `lastActivityAt` must be updated on BOTH job start AND job complete in `_runJob` — updating only on complete misses the window where the very first job is stuck before producing any result.
- `shouldSkip` in `top4top.js` must be checked BEFORE `fs.statSync(filePath)` call to avoid reading a file that won't be uploaded anyway.
- `CIRCUIT_OPEN` error code on top4top skip will propagate through `withRetry` in handler.js — it is NOT a `BOOMBOX_STAGE_TIMEOUT`, so `withRetry` will retry it (up to 3 attempts). This is intentional: the circuit may flip back between job attempts. If unwanted, add `CIRCUIT_OPEN` to the no-retry list in `withRetry`.

**Why:** Log-only health checks provide no actual HA value; auto-restart on confirmed stall is necessary for 24/7 uptime. Circuit breakers on Top4Top and Spotify oEmbed prevent thundering-herd retry storms when those services are down.
