/**
 * boomboxQueue.js — Multi-platform BoomBox queue (V3).
 *
 * Each platform (YouTube, TikTok, Spotify) gets its own independent
 * PlatformWorker so they never block each other. A YouTube download
 * won't hold up a TikTok or Spotify request.
 *
 * V3 changes vs V2:
 *   • Per-platform workers (youtube / tiktok / spotify)
 *   • Priority queue (Owner=0 > Developer=1 > Premium=2 > Free=3)
 *   • 90s hard job timeout (configurable via workerConfig)
 *   • Auto-retry with exponential back-off
 *   • Memory/CPU-aware concurrency scaling via WorkerManager
 *   • Health checks every 5 minutes
 *
 * Backward-compat shim:
 *   • `enqueueBoomBoxJob(run, callbacks)` still works — routes to a
 *     generic "boombox" worker for code that hasn't been updated yet.
 *
 * Primary API:
 *   • `enqueueForPlatform(platform, priority, run, callbacks)`
 *   • `getQueueSnapshot()`  — aggregates all three platform workers
 */

import { logger }     from "../../utils/logger.js";
import { enqueue, getAllSnapshots } from "./workerManager.js";
import { PRIORITY }   from "./workerConfig.js";

// Map platform name → worker name
const PLATFORM_WORKER_MAP = {
  YouTube: "youtube",
  TikTok:  "tiktok",
  Spotify: "spotify",
};

/**
 * Enqueue a BoomBox job on the correct platform worker.
 *
 * @param {"YouTube"|"TikTok"|"Spotify"} platform
 * @param {number} priority  Use PRIORITY.* constants (0=highest, 3=lowest)
 * @param {() => Promise<any>} run
 * @param {{
 *   onQueued?: (pos:number, total:number, etaSec:number) => any,
 *   onStart?:  () => any,
 *   jobId?:    string,
 * }} [callbacks]
 * @returns {Promise<any>}
 */
export function enqueueForPlatform(platform, priority, run, callbacks = {}) {
  const workerName = PLATFORM_WORKER_MAP[platform] ?? "youtube";
  logger.info(`[BoomBox Queue] Enqueue | platform=${platform} | worker=${workerName} | priority=${priority}`);
  return enqueue(workerName, run, { priority, ...callbacks });
}

/**
 * Backward-compatible shim — routes to a generic "youtube" worker.
 * New code should use enqueueForPlatform instead.
 *
 * @param {() => Promise<any>} run
 * @param {{ onQueued?: Function, onStart?: Function }} [callbacks]
 * @returns {Promise<any>}
 */
export function enqueueBoomBoxJob(run, callbacks = {}) {
  return enqueue("youtube", run, { priority: PRIORITY.FREE, ...callbacks });
}

/**
 * Aggregated queue snapshot across all BoomBox platform workers.
 * Used by getSnapshot-style code that previously read a single global queue.
 *
 * @returns {{ active:number, queued:number, maxConcurrent:number, workers: object[] }}
 */
export function getQueueSnapshot() {
  const all = getAllSnapshots().filter(s =>
    ["youtube", "tiktok", "spotify"].includes(s.name)
  );
  return {
    active:        all.reduce((s, w) => s + w.active,        0),
    queued:        all.reduce((s, w) => s + w.queued,        0),
    maxConcurrent: all.reduce((s, w) => s + w.maxConcurrent, 0),
    workers:       all,
  };
}

export { PRIORITY };
