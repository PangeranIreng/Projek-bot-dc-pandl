---
name: BoomBox module architecture
description: BoomBox queue/download module structure and the queue-stall fix applied.
---

ESM rewrites of ytmp3gg/top4top, all IDs in `config/*.js` (not `boomboxConfig.js` — after the
repo-root migration, config lives at repo-root `config/`), JSON-file DB, wired into
`src/index.js` before the scanner guard.

**Queue stall fix:** `src/features/queue/boomboxQueue.js` used to have no timeout on a running
job — a hung `ytdl`/`top4top` call (network stall, dead host) would occupy one of the
`MAX_CONCURRENT` (5) slots forever, with no way to recover short of a bot restart. Fixed by
racing `job.run()` against a 10-minute timeout in `runWithTimeout()`; on timeout the slot is
freed and the failure is reported via `logError` to Error Logs.

**Why:** production requirement was "queue must never get permanently stuck, no restart needed."
A `.finally()` on the running-slot bookkeeping only frees the slot when the wrapped promise
settles — if the real promise never settles, nothing downstream ever fires unless you race it
against something that does.

**How to apply:** any new long-running BoomBox job type must still go through
`enqueueBoomBoxJob()` so it inherits the timeout. Don't call heavy downloader work directly
from a command handler.
