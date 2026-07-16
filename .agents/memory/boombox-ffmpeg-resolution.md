---
name: BoomBox ffmpeg resolution
description: How ffmpeg is resolved across dev (Replit), Railway, Render, and VPS — shared utility, ffmpeg-static fallback, skip-transcode optimization.
---

## Rule
All ffmpeg path resolution goes through `src/utils/ffmpegPath.js`. Never call `which ffmpeg` inline in service files.

## Resolution order
1. `which ffmpeg` — system binary (fastest; works on Replit dev, standard Linux VPS, Render with build pack)
2. `require("ffmpeg-static")` — pre-built binary from the npm package (works on Railway and any host with no system ffmpeg)
3. Hard-coded `"ffmpeg"` string — last resort; may still fail but we never throw from the resolver

**Why:** Railway uses nixpacks; `nixpacks.toml` declares `ffmpeg` as a system package (preferred path), but nixpacks installs can be flaky. ffmpeg-static provides a guaranteed fallback that requires zero system config.

## package.json requirement
```json
"pnpm": { "onlyBuiltDependencies": ["ffmpeg-static"] }
```
Without this, pnpm silently skips the install script and the binary is never extracted.

## Skip-transcode rules
- **ytdl-core fallback** (`_ytdlCoreFallback`): downloads as `.m4a`. If user requested `mp4` → rename, no ffmpeg. If `mp3` → transcode with ffmpeg.
- **Kaizen downloader** (`kaizenDownloader.js`): CDN often delivers mp3 directly. If `ext === targetExt` → rename, no ffmpeg. If transcode fails AND raw file exists → serve raw file with correct ext as last resort.
- **yt-dlp path** (`_attempt`, `_pipedFallback`, `_invidiousFallback`): passes `--ffmpeg-location FFMPEG_PATH` to yt-dlp; yt-dlp handles all conversion internally.

**Why:** Skipping unnecessary transcode eliminates the single biggest point of failure on hosts without system ffmpeg, and removes ~2–5 s of processing time per download when the file is already in the right format.
