---
name: BoomBox cross-platform binary
description: How yt-dlp binary is resolved across Pterodactyl, Railway, Replit, and VPS — no hardcoding, system-first resolution.
---

## Rule
Never hardcode `yt-dlp_linux` or any platform binary name. Use the `_detectPlatformSuffix()` function and the resolution chain in `ytmp3gg.js`.

## Binary resolution order (in ytmp3gg.js at module load)
1. `which yt-dlp` in system PATH → `_USE_SYSTEM_YTDLP = true`, no download/update ever
2. `bin/yt-dlp_{suffix}` (e.g. `bin/yt-dlp_linux` on x64) — committed binary
3. `bin/yt-dlp` — generic committed fallback
4. Download from GitHub to `bin/yt-dlp_{suffix}` — fully automatic

**Why:** Pterodactyl panels commonly have yt-dlp installed via pip in PATH. The old hardcoded `yt-dlp_linux` path was always missing on those hosts, causing a 30s download timeout on every startup and falling through to backup providers. System-first detection fixes Pterodactyl without changing Railway or Replit behavior.

## Platform suffix mapping
- linux + x64 → `yt-dlp_linux`
- linux + arm64/aarch64 → `yt-dlp_linux_aarch64`
- linux + arm → `yt-dlp_linux_armv7l`
- darwin → `yt-dlp_macos`
- win32 → `yt-dlp.exe`

## System binary behavior (`_USE_SYSTEM_YTDLP = true`)
- `ensureBinary()` returns immediately (no fs check, no network)
- `_doInitBinary()` only runs `--version` to log the version; skips GitHub update check
- Download is never attempted (system admin owns the binary)

## Related new files
- `src/utils/cookiesResolver.js` — resolves YOUTUBE_COOKIES env var or `cookies.txt` in project root; exports `COOKIES_ARGS` ([] if not configured)
- `src/utils/envDetector.js` — detects Railway/Replit/Pterodactyl/VPS by checking env vars; used for startup log context only
- `src/utils/ffmpegPath.js` — system ffmpeg → ffmpeg-static bundle fallback

## package.json pnpm config required
```json
"pnpm": { "onlyBuiltDependencies": ["ffmpeg-static"] }
```
Without this, pnpm silently skips the ffmpeg-static install script and the binary is never extracted.
