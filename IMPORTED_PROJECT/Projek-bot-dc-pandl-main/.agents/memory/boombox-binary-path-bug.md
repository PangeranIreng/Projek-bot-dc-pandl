---
name: BoomBox yt-dlp binary path bug (root cause of Analyzing Link stuck)
description: Wrong BIN_DIR path caused every request to attempt a fresh binary download that always timed out on Replit — the primary cause of BoomBox stuck at "Analyzing Link..."
---

# BoomBox yt-dlp Binary Path Bug

## The Rule
`BIN_DIR` must use TWO levels of `..` from `src/services/`, not one.

```js
// WRONG (resolves to src/bin/ — non-existent):
const BIN_DIR = path.join(__dirname, "..", "bin");

// CORRECT (resolves to <workspace_root>/bin/ — where yt-dlp_linux is committed):
const BIN_DIR = path.join(__dirname, "..", "..", "bin");
```

**Why:** `ytmp3gg.js` lives at `src/services/ytmp3gg.js`. One `..` from `src/services/` gives `src/`. Two `..` gives the workspace root where `bin/yt-dlp_linux` actually lives.

## What broke (cascade)
1. `fs.existsSync(BIN_PATH)` always returned false → `initBinary()` always tried to download
2. GitHub binary download timed out after 30s on Replit's network
3. `_binaryInitPromise` was cleared to null on failure → next request retried same download
4. `ensureBinary()` in `getVideoInfo()` threw before health check ran → pipeline died instead of falling back
5. Embed stuck at "Analyzing Link..." because error was thrown before embed could be updated to FAILED

## Secondary defensive fixes applied alongside path fix
- `ensureBinary()`: if download fails, drive both yt-dlp-youtube and yt-dlp-tiktok to OFFLINE (5x recordFailure) → future requests skip yt-dlp immediately instead of retrying download
- `getVideoInfo()`: moved health check BEFORE `ensureBinary()` call + wrapped `ensureBinary()` in try/catch → returns nulls on binary failure (non-fatal)
- `ytdl()`: wrapped `ensureBinary()` in try/catch → continues to `_ytdlYouTube`/`_ytdlTikTok` which use fallback chain (ytdl-core, kaizenapi don't need the binary)

## How to apply
Any time BIN_DIR is computed from `__dirname` inside a file that is NOT at the workspace root, count the exact depth and use the correct number of `..` hops. Verify with `fs.existsSync(BIN_PATH)` before deploying.
