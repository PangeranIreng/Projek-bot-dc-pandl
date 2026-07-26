---
name: BoomBox Provider Health V2
description: Error categorization, smarter OFFLINE decisions, per-instance health for Piped/Invidious, cookie temp-disable, providerMonitor service.
---

# BoomBox Provider Health V2

## Rule
Only true connectivity failures (NetworkError, HTTPError 5xx) count toward the OFFLINE circuit-breaker threshold. CookieError, AntiBot, FormatNotAvailable, UnsupportedVideo, and RateLimit do NOT mark a provider OFFLINE.

**Why:** Previously all errors incremented the OFFLINE counter equally. A single expired cookies file or a YouTube anti-bot challenge (both client-side, not provider-side) could push yt-dlp OFFLINE, causing all subsequent requests to skip it entirely. Anti-bot and cookie errors require different responses (method rotation / cookie refresh), not provider blacklisting.

**How to apply:**
- Import `classifyError()` from `src/services/providerHealth.js` before calling `recordFailure()`
- Pass `category: classifyError(err.message)` to `recordFailure()`
- For cookie errors: also call `disableCookiesTemporarily()` from `src/services/ytmp3gg.js`

## Key design points
- `ERROR_CATEGORY` enum exported from `providerHealth.js` — 9 categories
- RateLimit triggers `_rateLimitBackoff` (2 min), not OFFLINE (5 min)
- `getProblematicProviders()` — only returns OFFLINE or RATE_LIMITED providers (for dashboard)

## providerMonitor.js
New file: `src/services/providerMonitor.js` — persists per-provider stats in boombox-db.json via `db.getProviderMonitor()`/`setProviderMonitor()`. Call `initProviderMonitor(db)` from `ready.js` after DB is ready.

## Piped / Invidious per-instance health
Both `_pipedFallback()` and `_invidiousFallback()` now track per-instance failure counts. After `PIPED_INSTANCE_FAIL_THRESHOLD` (2) consecutive fails, an instance is skipped for 15 min. Timeout per instance reduced from 12s → 5s.

## Cookie temp-disable
`disableCookiesTemporarily()` in `ytmp3gg.js` — sets `_cookiesDisabledUntil` for 10 min. `resetCookieDisable()` clears it immediately. `_attempt()` checks `_cookiesTemporarilyDisabled()` before adding COOKIES_ARGS.

## Method timeouts (ytdl YouTube)
Methods 0–2: 15s (was 20s). Method 3: 25s (was 30s). Last: 60s (was 90s).

## ytdl-core format selection
No longer hardcodes `{ quality: "highestaudio" }`. Uses `ytdlCore.filterFormats(info.formats, "audioonly")`, sorts by bitrate descending, prefers m4a container. Falls back to muxed audio if no audio-only formats exist.
