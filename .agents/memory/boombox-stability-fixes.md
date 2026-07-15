---
name: BoomBox stability fixes (production hardening)
description: Root causes of BoomBox stuck/failure + all surgical fixes applied, with file locations.
---

# BoomBox Stability Fixes

## Critical bugs fixed

**1. Timeout = permanent failure (the main silent-fallback killer)**
- File: `src/services/ytmp3gg.js`, `_isPermanentFailure()`
- `"timed out"` was in the permanent-failure list → yt-dlp timeout skipped ytdl-core + kaizenapi entirely
- Fix: removed `"timed out"` from permanent list. Timeouts are transient; they MUST trigger fallback.

**2. `ensureBinary()` per-request GitHub API call + concurrency race**
- File: `src/services/ytmp3gg.js`
- Every `ytdl()` + `getVideoInfo()` called `ensureBinary()` which hit GitHub API for version check
- No mutex: 20 concurrent requests could all trigger `_downloadBinary()` at once → file corruption
- Fix: `initBinary()` (exported) called once at startup in `ready.js`; per-request `ensureBinary()` is now just `fs.existsSync(BIN_PATH)` + wait on the singleton promise.

**3. No AbortController → zombie yt-dlp processes on stage timeout**
- File: `src/features/boombox/handler.js`, `withStageTimeout()`
- Stage timeout fired via `Promise.race` but yt-dlp child process kept running forever
- Fix: `withStageTimeout` now accepts a factory `(signal) => Promise`; creates `AbortController` internally and calls `controller.abort()` before rejecting. `ytdl()` call updated to factory pattern.

**4. `getVideoInfo()` ignored provider health circuit breaker**
- File: `src/services/ytmp3gg.js`, `getVideoInfo()`
- When yt-dlp was OFFLINE, every metadata fetch still tried yt-dlp and waited 20s for timeout
- Fix: added `providerHealth.shouldSkip(healthKey)` check at top of `getVideoInfo()`; returns nulls immediately if OFFLINE.

**5. top4top.js ReadStream fd leak on error**
- File: `src/services/top4top.js`, `_doUpload()`
- `fs.createReadStream()` passed directly to `form.append()` → if axios threw, stream never closed
- Fix: named variable `readStream`, explicit `readStream.destroy()` in catch block.

## Architecture invariants to preserve
- `_isPermanentFailure()` must NEVER include network/timeout errors — only truly permanent per-video outcomes (deleted, private, region-blocked, age-restricted).
- `initBinary()` is the only function that calls `_fetchLatestYtdlpVersion()`. Never add a GitHub API call inside `ensureBinary()` or any per-request path.
- `withStageTimeout` with a factory fn creates+aborts its own `AbortController`. Plain Promise callers (getVideoInfo, top4top) still work unchanged.
- Startup init: `initBinary()` called in `src/events/ready.js` `handleReady()` — non-fatal if it fails.

**Why:** All 5 bugs were root causes of BoomBox getting stuck in production under real concurrent load. They were non-obvious because each had a plausible-looking fix that was actually wrong (e.g. classifying timeout as permanent "to stop retrying" inadvertently broke the whole fallback chain).
