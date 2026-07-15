---
name: BoomBox "Analyzing" stage hang — root cause and fix pattern
description: Why BoomBox jobs could freeze forever at the info-fetch stage, and the timeout-layering pattern used to fix it.
---

`ensureBinary()` in `ytmp3gg.js` (called at the very top of both `getVideoInfo()` and `ytdl()`)
used to fetch the yt-dlp binary from GitHub via plain `https.get()` with **no timeout at all**.
A stalled connection (TCP connected, zero bytes ever received) hung that promise forever,
freezing the job's very first pipeline stage ("Fetch Video Info" / the "🔍 Analyzing Link..."
embed) with no error, no Error Log entry, and no user-facing failure — the only eventual
recovery was the queue's 10-minute hard ceiling, which itself never told the requester anything
(the enqueue call site had no `.catch`, so the queue-timeout rejection was an unhandled promise
rejection).

**Why:** Node's `https.get`/`https.request` `timeout` option is an *idle* timer (resets on every
byte of activity), not a fixed deadline — it's the correct tool for "detect a stalled connection"
without penalizing genuinely slow-but-alive transfers. Every outbound request/stream in this
module needs one; `@distube/ytdl-core`'s `getInfo()`/download stream expose no timeout option of
their own, so those needed an external `Promise.race` wrapper instead.

**How to apply:** any new outbound HTTP call or stream added to the BoomBox pipeline (`ytmp3gg.js`,
`kaizenDownloader.js`, `top4top.js`) must set an explicit idle/overall timeout — check for a native
`timeout` option first (Node's http/https, axios); if the library has none, wrap it with a
`Promise.race` timeout helper and make sure to `.destroy()` the underlying request/stream on
timeout, not just let the promise settle. Layer timeouts at both the individual-request level
*and* the pipeline-stage level (`handler.js`'s `withStageTimeout` around Fetch Video Info /
Download Audio / Upload to Top4Top) so a stuck stage routes into the existing failure path
(Error Log + user-facing failure embed + `finally`-released queue slot) instead of silently
freezing — don't rely solely on the outer queue-level ceiling (`boomboxQueue.js`'s
`JOB_TIMEOUT_MS`), since that only frees the concurrency slot and has no reference to the job's
Discord status message to notify the user with.
