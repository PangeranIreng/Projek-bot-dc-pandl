---
name: BoomBox V3 Worker Architecture
description: Multi-platform worker system replacing the single global queue; covers key design decisions and wiring points.
---

# BoomBox V3 Worker Architecture

## Rule
Never collapse the three platform workers (youtube/tiktok/spotify) back into a single global queue — the whole point of V3 is isolation so one platform can't stall another.

**Why:** User explicitly requested "Ketiganya langsung diproses bersamaan. Bukan antre menjadi satu."

**How to apply:** Any new BoomBox-style feature should call `enqueueForPlatform(platform, priority, run, callbacks)` from `src/features/queue/boomboxQueue.js`, not the legacy `enqueueBoomBoxJob`.

---

## Architecture Map

| File | Role |
|------|------|
| `src/features/queue/workerConfig.js` | Constants: WORKER_DEFAULTS, PRIORITY, thresholds |
| `src/features/queue/platformWorker.js` | Per-platform worker: priority queue, concurrency, timeout, retry, auto-restart |
| `src/features/queue/workerManager.js` | Registry, resource monitor (RAM/CPU), health checks, initWorkerManager() |
| `src/features/queue/boomboxQueue.js` | Public API: enqueueForPlatform(), enqueueBoomBoxJob() shim, getQueueSnapshot() |
| `src/commands/workerstatus.js` | /workerstatus slash command (Owner/Developer) |
| `src/database/boomboxDB.js` | getWorkerConfig() / setWorkerConfig() — persistent worker config |
| `src/events/ready.js` | Calls initWorkerManager(db) + setWorkerManagerClient(client) after login |

---

## Priority Levels (PRIORITY constant)
- 0 = Owner (hardcoded user IDs from config/owner.js + role)
- 1 = Developer
- 2 = Premium
- 3 = Free

Priority is resolved in `handler.js` → `getJobPriority(member)`.

---

## Stage-Level Retry
`withRetry(fn, maxAttempts=3, label)` wraps the **download** and **upload** stages inside `runBoomBoxJob`. Does NOT retry on BOOMBOX_STAGE_TIMEOUT (those already consumed the time window).

Worker-level retry (in `platformWorker.js`) is separate and wraps the entire `run()` call — the two layers are independent.

---

## Concurrency Scaling
- RAM > 80% or CPU > 85% → all workers throttled to 50% of base concurrency (floor: 1)
- Checked every 15s via `_startResourceMonitor()` in workerManager.js
- Restored automatically when pressure drops

---

## Persistent Config
Worker overrides survive restarts via `BoomBoxDB.getWorkerConfig() / setWorkerConfig()`. Loaded at `initWorkerManager(db)` time and merged over WORKER_DEFAULTS.
