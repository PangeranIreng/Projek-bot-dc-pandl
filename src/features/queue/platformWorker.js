/**
 * platformWorker.js — Self-contained per-platform worker.
 *
 * Features:
 *   • Priority queue (Owner=0 > Developer=1 > Premium=2 > Free=3)
 *   • Configurable concurrency (scales down under resource pressure)
 *   • Per-job 90s (configurable) hard timeout
 *   • Auto-retry up to maxRetries times with exponential back-off
 *   • Error isolation — a crashed job never kills the worker
 *   • Auto-restart — if the internal tick loop itself errors, reschedule
 *   • Per-worker statistics and status reporting
 */

import { logger }   from "../../utils/logger.js";
import { logError } from "../../utils/errorLogger.js";

// Rolling average of the last N completed job durations for ETA estimates.
const DURATION_HISTORY = 20;
const DEFAULT_ESTIMATE_MS = 8_000;

export class PlatformWorker {
  /**
   * @param {string} name  e.g. "youtube", "tiktok", "scanner"
   * @param {{ maxConcurrent?: number, timeoutMs?: number, maxRetries?: number }} config
   */
  constructor(name, config = {}) {
    this.name           = name;
    this.maxConcurrent  = config.maxConcurrent ?? 3;
    this.timeoutMs      = config.timeoutMs     ?? 90_000;
    this.maxRetries     = config.maxRetries     ?? 3;

    /** @private */
    this._baseMaxConcurrent = this.maxConcurrent; // original; restored when pressure lifts
    /** @private */
    this._running  = new Set();   // active job objects
    /** @private */
    this._queue    = [];          // pending job objects, priority-sorted
    /** @private */
    this._durations = [];         // rolling duration history (ms)

    this.stats = {
      success:  0,
      failure:  0,
      retries:  0,
      timeouts: 0,
    };

    // Status: 'idle' | 'running' | 'busy' | 'restarting'
    this.status = "idle";
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Enqueue a job for this worker.
   *
   * @param {() => Promise<any>} run  The actual work function.
   * @param {{
   *   priority?: number,
   *   onQueued?: (pos:number, total:number, etaSec:number) => any,
   *   onStart?:  () => any,
   *   jobId?:    string,
   * }} [opts]
   * @returns {Promise<any>}
   */
  enqueue(run, opts = {}) {
    const { priority = 3, onQueued, onStart, jobId } = opts;
    return new Promise((resolve, reject) => {
      const job = {
        run, priority, onQueued, onStart,
        jobId: jobId ?? `${this.name}-${Date.now()}`,
        resolve, reject,
        enqueuedAt: Date.now(),
      };
      this._insertSorted(job);
      this._notifyQueue();
      this._tick();
    });
  }

  /** Snapshot of worker state for /workerstatus. */
  getSnapshot() {
    return {
      name:          this.name,
      status:        this.status,
      active:        this._running.size,
      queued:        this._queue.length,
      maxConcurrent: this.maxConcurrent,
      stats:         { ...this.stats },
      avgDurationMs: this._avgDuration(),
    };
  }

  /**
   * Called by ResourceMonitor to apply pressure (reduce concurrency).
   * @param {number} newMax  Must be >= 1.
   */
  applyPressure(newMax) {
    const clamped = Math.max(1, Math.floor(newMax));
    if (clamped !== this.maxConcurrent) {
      logger.warn(`[Worker:${this.name}] Concurrency throttled: ${this.maxConcurrent} → ${clamped}`);
      this.maxConcurrent = clamped;
    }
  }

  /** Restore concurrency to original config after pressure lifts. */
  releasePressure() {
    if (this.maxConcurrent !== this._baseMaxConcurrent) {
      logger.info(`[Worker:${this.name}] Concurrency restored: ${this.maxConcurrent} → ${this._baseMaxConcurrent}`);
      this.maxConcurrent = this._baseMaxConcurrent;
      this._tick(); // may unblock queued jobs
    }
  }

  /**
   * Update the base (and current) max concurrency from external config.
   * @param {number} n
   */
  setMaxConcurrent(n) {
    this._baseMaxConcurrent = Math.max(1, n);
    this.maxConcurrent      = this._baseMaxConcurrent;
    this._tick();
  }

  /** Soft restart: mark as restarting, drain new jobs to queue, resume tick. */
  restart() {
    this.status = "restarting";
    logger.warn(`[Worker:${this.name}] Restarting (${this._running.size} active jobs will finish naturally)...`);
    // Running jobs finish normally; queue drains as slots free up.
    setTimeout(() => {
      this.status = this._running.size > 0 ? "running" : "idle";
      this._tick();
      logger.info(`[Worker:${this.name}] Restart complete.`);
    }, 500);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /** Insert job into _queue maintaining ascending priority order. */
  _insertSorted(job) {
    // Lower priority number = higher priority = goes earlier in queue.
    // Among equal priority, FIFO (enqueuedAt).
    let idx = this._queue.findIndex(
      j => j.priority > job.priority ||
           (j.priority === job.priority && j.enqueuedAt > job.enqueuedAt)
    );
    if (idx === -1) this._queue.push(job);
    else this._queue.splice(idx, 0, job);
  }

  /** Drain queue while slots are available. */
  _tick() {
    if (this.status === "restarting") return;
    try {
      while (this._running.size < this.maxConcurrent && this._queue.length > 0) {
        const job = this._queue.shift();
        this._runJob(job); // fire-and-forget; resolves/rejects the job's promise
      }
      this._updateStatus();
    } catch (err) {
      logger.error(`[Worker:${this.name}] _tick error (scheduling auto-recovery): ${err.message}`);
      this.status = "restarting";
      setTimeout(() => { this.status = "idle"; this._tick(); }, 1_000);
    }
  }

  /** Execute a single job with timeout + retry. Isolated — never throws. */
  async _runJob(job) {
    this._running.add(job);
    this._updateStatus();
    this._notifyQueue();

    try {
      await job.onStart?.();
    } catch (e) {
      logger.warn(`[Worker:${this.name}] onStart callback failed: ${e.message}`);
    }

    const startedAt = Date.now();
    let lastErr;
    let succeeded  = false;

    try {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          const result = await this._runWithTimeout(job.run);
          const dur    = Date.now() - startedAt;
          this._recordDuration(dur);
          this.stats.success++;
          logger.info(`[Worker:${this.name}] ✅ Job ${job.jobId} done in ${(dur / 1000).toFixed(1)}s (attempt ${attempt})`);
          succeeded = true;
          job.resolve(result);
          return;
        } catch (err) {
          lastErr = err;
          if (err?.code === "WORKER_TIMEOUT") this.stats.timeouts++;

          if (attempt < this.maxRetries && err?.code !== "WORKER_TIMEOUT") {
            this.stats.retries++;
            const backoffMs = 2_000 * attempt;
            logger.warn(`[Worker:${this.name}] ⚠ Job ${job.jobId} attempt ${attempt}/${this.maxRetries} failed: ${err.message} — retry in ${backoffMs}ms`);
            await sleep(backoffMs);
          } else {
            logger.error(`[Worker:${this.name}] ❌ Job ${job.jobId} failed (attempt ${attempt}/${this.maxRetries}): ${err.message}`);
            break;
          }
        }
      }

      if (!succeeded) {
        this.stats.failure++;
        try {
          await logError({
            feature: `Worker:${this.name}`,
            reason:  lastErr?.message ?? "Unknown error",
            stage:   "Job Failure",
            error:   lastErr,
          });
        } catch {}
        job.reject(lastErr);
      }
    } finally {
      // Always free the slot and kick the next job, regardless of success/failure.
      this._running.delete(job);
      this._updateStatus();
      this._tick();
    }
  }

  /**
   * Run a job, optionally racing against a hard timeout.
   *
   * When `this.timeoutMs` is 0 or falsy the timeout is disabled and the job
   * runs unconstrained — the caller (e.g. BoomBox handler) is responsible for
   * its own stage-level guards. This avoids a situation where the worker kills
   * a valid long download before the stage timeout can fire.
   */
  _runWithTimeout(run) {
    // Timeout disabled — just run the job.
    if (!this.timeoutMs) {
      return Promise.resolve().then(() => run());
    }

    return new Promise((resolve, reject) => {
      let timer;
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => {
          const err = new Error(`Job exceeded ${Math.round(this.timeoutMs / 1000)}s timeout`);
          err.code = "WORKER_TIMEOUT";
          rej(err);
        }, this.timeoutMs);
      });

      Promise.race([Promise.resolve().then(() => run()), timeout])
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }

  /** Notify all waiting jobs of their current position + ETA. */
  _notifyQueue() {
    const avg = this._avgDuration();
    this._queue.forEach((job, idx) => {
      const position = idx + 1;
      const wavesAhead = Math.floor((position - 1) / Math.max(1, this.maxConcurrent));
      const etaSec = Math.max(1, Math.round((avg * (wavesAhead + 1)) / 1000));
      try { job.onQueued?.(position, this._queue.length, etaSec); } catch {}
    });
  }

  _recordDuration(ms) {
    this._durations.push(ms);
    if (this._durations.length > DURATION_HISTORY) this._durations.shift();
  }

  _avgDuration() {
    if (this._durations.length === 0) return DEFAULT_ESTIMATE_MS;
    return this._durations.reduce((a, b) => a + b, 0) / this._durations.length;
  }

  _updateStatus() {
    if (this.status === "restarting") return;
    if (this._running.size === 0 && this._queue.length === 0) {
      this.status = "idle";
    } else if (this._running.size >= this.maxConcurrent) {
      this.status = "busy";
    } else {
      this.status = "running";
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
