/**
 * boomboxQueue.js — Bounded-concurrency FIFO queue for BoomBox jobs.
 *
 * At most MAX_CONCURRENT jobs run at once (per spec: 3~5); every extra
 * request waits in a plain FIFO array and is started the moment a slot
 * frees up. Callers get position/ETA callbacks so they can render a
 * (DM-based, effectively-private) queue notice without touching the
 * BoomBox channel more than once per request.
 */

import { logger } from "../../utils/logger.js";
import { logError } from "../../utils/errorLogger.js";

const MAX_CONCURRENT = 5; // max 5 simultaneous BoomBox jobs per spec

// Hard ceiling on a single job's runtime. Without this, a hung download
// (ytdl/top4top never resolving or rejecting) would permanently occupy one
// of the MAX_CONCURRENT slots until the bot process was restarted. This
// does not cancel the underlying work -- it just frees the queue slot so
// new requests keep flowing, and reports the stall to Error Logs.
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** @type {Set<object>} */
const running = new Set();
/** @type {Array<{run: Function, resolve: Function, reject: Function, onQueued?: Function, onStart?: Function}>} */
const queue = [];

// Rolling average of the last N completed job durations — used to give
// queued users a real estimate instead of a hardcoded guess.
const DURATION_HISTORY = 20;
const DEFAULT_ESTIMATE_MS = 5000; // sane guess before any job has completed
const jobDurationsMs = [];

function averageDurationMs() {
  if (jobDurationsMs.length === 0) return DEFAULT_ESTIMATE_MS;
  return jobDurationsMs.reduce((a, b) => a + b, 0) / jobDurationsMs.length;
}

function recordDuration(ms) {
  jobDurationsMs.push(ms);
  if (jobDurationsMs.length > DURATION_HISTORY) jobDurationsMs.shift();
}

/** Recompute and push position/ETA to everyone still waiting. */
function notifyQueue() {
  const avg = averageDurationMs();
  queue.forEach((job, idx) => {
    const position = idx + 1;
    // Rough estimate: full "waves" of MAX_CONCURRENT ahead of this job,
    // each wave taking ~avg ms, plus one more wave for this job itself.
    const wavesAhead = Math.floor((position - 1) / MAX_CONCURRENT);
    const etaSec = Math.max(1, Math.round((avg * (wavesAhead + 1)) / 1000));
    try {
      job.onQueued?.(position, queue.length, etaSec);
    } catch (e) {
      logger.warn(`[BoomBox Queue] onQueued callback failed: ${e.message}`);
    }
  });
}

/**
 * Races a job's run() against JOB_TIMEOUT_MS so a hung download can never
 * hold a concurrency slot forever. The underlying promise is left to settle
 * on its own (its result is ignored once the timeout wins) -- there is no
 * way to forcibly cancel an in-flight ytdl/top4top call, but the queue slot
 * is freed immediately so the bot keeps serving other requests.
 */
function runWithTimeout(run) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Job exceeded ${JOB_TIMEOUT_MS / 1000}s timeout`);
      err.code = "BOOMBOX_QUEUE_TIMEOUT";
      reject(err);
    }, JOB_TIMEOUT_MS);
  });

  return Promise.race([run(), timeout])
    .finally(() => clearTimeout(timer))
    .catch((err) => {
      if (err?.code === "BOOMBOX_QUEUE_TIMEOUT") {
        logger.error(`[BoomBox Queue] ${err.message} — freeing slot`);
        logError({
          feature: "BoomBox Queue",
          reason:  err.message,
          stage:   "Job Timeout",
          error:   err,
        }).catch(() => {});
      }
      throw err;
    });
}

function startNext() {
  if (running.size >= MAX_CONCURRENT) return;
  const job = queue.shift();
  if (!job) return;

  running.add(job);
  notifyQueue(); // positions shifted for everyone still behind

  const startedAt = Date.now();
  Promise.resolve()
    .then(() => job.onStart?.())
    .catch((e) => logger.warn(`[BoomBox Queue] onStart callback failed: ${e.message}`))
    .then(() => runWithTimeout(job.run))
    .then(job.resolve, job.reject)
    .finally(() => {
      recordDuration(Date.now() - startedAt);
      running.delete(job);
      startNext();
    });
}

/**
 * Enqueue a BoomBox job. Runs immediately if a slot is free; otherwise
 * waits in FIFO order.
 *
 * @param {() => Promise<any>} run  The actual BoomBox pipeline (assumed to
 *   already catch its own errors internally — this queue does not retry).
 * @param {object} [callbacks]
 * @param {(position:number, total:number, etaSec:number) => any} [callbacks.onQueued]
 *   Invoked (possibly repeatedly, as position changes) while this job is
 *   still waiting. Never invoked if the job starts immediately.
 * @param {() => any} [callbacks.onStart]  Invoked right before `run()`
 *   starts — the right place to clear any queue notice.
 * @returns {Promise<any>}
 */
export function enqueueBoomBoxJob(run, { onQueued, onStart } = {}) {
  return new Promise((resolve, reject) => {
    const willWait = running.size >= MAX_CONCURRENT;
    queue.push({ run, resolve, reject, onQueued, onStart });
    if (willWait) {
      logger.info(`[BoomBox Queue] Job queued — position ${queue.length}/${queue.length}, ${running.size} active`);
      notifyQueue();
    }
    startNext();
  });
}

/** @returns {{active:number, queued:number, maxConcurrent:number}} */
export function getQueueSnapshot() {
  return { active: running.size, queued: queue.length, maxConcurrent: MAX_CONCURRENT };
}
