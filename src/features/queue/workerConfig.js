/**
 * workerConfig.js — Default configuration for all platform workers.
 *
 * Values here are used as defaults. Persistent overrides are stored in
 * BoomBoxDB (getWorkerConfig / setWorkerConfig) and loaded at startup by
 * workerManager.js so settings survive bot restarts/redeploys.
 */

/**
 * Default concurrency, timeout and retry settings per worker.
 *
 * timeoutMs = 0 → worker-level timeout DISABLED; rely on stage-level guards.
 * BoomBox platform workers (youtube/tiktok/spotify) must be 0 because their
 * pipeline already has per-stage timeouts (up to 5 min × 3 retries each) via
 * withStageTimeout() in handler.js. Applying a second, shorter hard ceiling at
 * the worker level would abort valid long downloads before the stage guard fires.
 */
export const WORKER_DEFAULTS = {
  // BoomBox — no worker-level timeout; stage-level guards in handler.js own the limit.
  youtube:    { maxConcurrent: 3, timeoutMs: 0,       maxRetries: 3 },
  tiktok:     { maxConcurrent: 3, timeoutMs: 0,       maxRetries: 3 },
  spotify:    { maxConcurrent: 3, timeoutMs: 0,       maxRetries: 3 },
  // Feature workers — simpler operations with predictable ceilings.
  scanner:    { maxConcurrent: 5, timeoutMs: 120_000, maxRetries: 1 },
  obfuscator: { maxConcurrent: 5, timeoutMs: 60_000,  maxRetries: 1 },
  beautify:   { maxConcurrent: 5, timeoutMs: 60_000,  maxRetries: 1 },
  ai:         { maxConcurrent: 5, timeoutMs: 60_000,  maxRetries: 1 },
  database:   { maxConcurrent: 3, timeoutMs: 30_000,  maxRetries: 2 },
};

/**
 * Job priority levels — lower number = processed first.
 * Passed to enqueue() as the `priority` option.
 */
export const PRIORITY = {
  OWNER:     0,
  DEVELOPER: 1,
  PREMIUM:   2,
  FREE:      3,
};

/** Automatically reduce concurrency when RAM usage exceeds this fraction. */
export const MEMORY_THROTTLE_THRESHOLD = 0.80;

/** Automatically reduce concurrency when CPU 1-second load exceeds this fraction. */
export const CPU_THROTTLE_THRESHOLD = 0.85;

/** How often to run the system health check (ms). */
export const HEALTH_CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes

/** How often to check RAM/CPU and scale concurrency (ms). */
export const RESOURCE_CHECK_INTERVAL_MS = 15_000; // 15 seconds

/** Minimum concurrency floor when under resource pressure. */
export const MIN_CONCURRENCY = 1;
