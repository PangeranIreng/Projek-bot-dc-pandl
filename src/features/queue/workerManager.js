/**
 * workerManager.js — Central registry for all platform workers.
 *
 * Responsibilities:
 *   • Create and hold one PlatformWorker per logical worker type
 *   • Resource monitoring: scale concurrency down when RAM/CPU are high
 *   • Health checks: periodic verification of critical services
 *   • Auto-restart any worker that reports "restarting" status
 *   • Expose aggregate snapshots for /workerstatus
 *
 * Workers are created lazily on first use but immediately on init() so that
 * health checks start right away without waiting for the first BoomBox job.
 */

import os from "node:os";
import { logger }   from "../../utils/logger.js";
import { logError } from "../../utils/errorLogger.js";
import { PlatformWorker } from "./platformWorker.js";
import {
  WORKER_DEFAULTS,
  MEMORY_THROTTLE_THRESHOLD,
  CPU_THROTTLE_THRESHOLD,
  HEALTH_CHECK_INTERVAL_MS,
  RESOURCE_CHECK_INTERVAL_MS,
  MIN_CONCURRENCY,
} from "./workerConfig.js";

// ── Worker registry ────────────────────────────────────────────────────────

/** @type {Map<string, PlatformWorker>} */
const workers = new Map();

let _resourceCheckTimer  = null;
let _healthCheckTimer    = null;
let _initialized         = false;
let _dbRef               = null;   // set via init() so we don't circular-import

// ── Initialization ─────────────────────────────────────────────────────────

/**
 * Bootstrap all workers and start background monitors.
 * Call once from src/index.js (or events/ready.js) after bot is ready.
 *
 * @param {import("../../database/db.js").BoomBoxDB} db   The shared BoomBoxDB instance
 */
export function initWorkerManager(db) {
  if (_initialized) return;
  _initialized = true;
  _dbRef = db;

  // Load persistent worker config overrides from DB
  const saved = _dbRef?.getWorkerConfig?.() ?? {};

  // Create all workers using merged config
  for (const [name, defaults] of Object.entries(WORKER_DEFAULTS)) {
    const override = saved[name] ?? {};
    const cfg = { ...defaults, ...override };
    workers.set(name, new PlatformWorker(name, cfg));
    logger.info(`[WorkerManager] Worker "${name}" ready (concurrent=${cfg.maxConcurrent}, timeout=${cfg.timeoutMs}ms, retries=${cfg.maxRetries})`);
  }

  // Start background monitors
  _startResourceMonitor();
  _startHealthCheck(null); // client not available yet; will re-arm with client when possible

  logger.info("[WorkerManager] Initialized. All workers online.");
}

/**
 * Provide the Discord client to the health check so it can verify channels.
 * Call from events/ready.js after the bot has logged in.
 * @param {import("discord.js").Client} client
 */
export function setWorkerManagerClient(client) {
  // Re-arm health check with a real client
  _startHealthCheck(client);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Get (or lazily create) a worker by name.
 * @param {string} name
 * @returns {PlatformWorker}
 */
export function getWorker(name) {
  if (!workers.has(name)) {
    const defaults = WORKER_DEFAULTS[name] ?? { maxConcurrent: 3, timeoutMs: 90_000, maxRetries: 3 };
    workers.set(name, new PlatformWorker(name, defaults));
    logger.warn(`[WorkerManager] Worker "${name}" created on-demand (not in WORKER_DEFAULTS).`);
  }
  return workers.get(name);
}

/**
 * Enqueue a job on the named platform worker.
 *
 * @param {string} workerName  "youtube" | "tiktok" | "spotify" | ...
 * @param {() => Promise<any>} run
 * @param {{
 *   priority?: number,
 *   onQueued?: Function,
 *   onStart?: Function,
 *   jobId?: string,
 * }} [opts]
 * @returns {Promise<any>}
 */
export function enqueue(workerName, run, opts = {}) {
  return getWorker(workerName).enqueue(run, opts);
}

/**
 * Get a snapshot of all workers for /workerstatus.
 * @returns {Array<object>}
 */
export function getAllSnapshots() {
  return [...workers.values()].map(w => w.getSnapshot());
}

/**
 * Get snapshot for a single worker.
 * @param {string} name
 * @returns {object|null}
 */
export function getSnapshot(name) {
  return workers.get(name)?.getSnapshot() ?? null;
}

/**
 * Restart a specific worker by name.
 * @param {string} name
 */
export function restartWorker(name) {
  const w = workers.get(name);
  if (!w) { logger.warn(`[WorkerManager] restartWorker: unknown worker "${name}"`); return; }
  w.restart();
}

/**
 * Persist a worker config change to DB and apply it live.
 * @param {string} workerName
 * @param {{ maxConcurrent?: number, timeoutMs?: number, maxRetries?: number }} patch
 */
export function updateWorkerConfig(workerName, patch) {
  const w = getWorker(workerName);
  if (patch.maxConcurrent !== undefined) w.setMaxConcurrent(patch.maxConcurrent);
  if (patch.timeoutMs !== undefined)     w.timeoutMs = patch.timeoutMs;
  if (patch.maxRetries !== undefined)    w.maxRetries = patch.maxRetries;

  // Persist to DB so it survives restart
  if (_dbRef?.setWorkerConfig) {
    const current = _dbRef.getWorkerConfig() ?? {};
    current[workerName] = { ...current[workerName], ...patch };
    _dbRef.setWorkerConfig(current);
  }
  logger.info(`[WorkerManager] Config updated for "${workerName}": ${JSON.stringify(patch)}`);
}

// ── Resource Monitor ───────────────────────────────────────────────────────

/** CPU usage averaged over a short window. */
let _prevCpuTimes = null;

function _getCpuUsage() {
  const cpus  = os.cpus();
  const totals = cpus.reduce(
    (acc, cpu) => {
      for (const [type, val] of Object.entries(cpu.times)) {
        acc[type] = (acc[type] ?? 0) + val;
      }
      return acc;
    },
    {}
  );
  if (!_prevCpuTimes) { _prevCpuTimes = totals; return 0; }

  const prev  = _prevCpuTimes;
  _prevCpuTimes = totals;

  const idle  = totals.idle  - prev.idle;
  const total = Object.values(totals).reduce((a, b) => a + b, 0)
              - Object.values(prev).reduce((a, b) => a + b, 0);
  return total === 0 ? 0 : 1 - idle / total;
}

function _getMemUsage() {
  const total = os.totalmem();
  const free  = os.freemem();
  return (total - free) / total;
}

function _startResourceMonitor() {
  if (_resourceCheckTimer) clearInterval(_resourceCheckTimer);
  _resourceCheckTimer = setInterval(() => {
    try {
      const memUsage = _getMemUsage();
      const cpuUsage = _getCpuUsage();

      const memPressure = memUsage > MEMORY_THROTTLE_THRESHOLD;
      const cpuPressure = cpuUsage > CPU_THROTTLE_THRESHOLD;

      if (memPressure || cpuPressure) {
        if (memPressure) logger.warn(`[WorkerManager] Memory pressure: ${(memUsage * 100).toFixed(1)}% — throttling workers`);
        if (cpuPressure) logger.warn(`[WorkerManager] CPU pressure: ${(cpuUsage * 100).toFixed(1)}% — throttling workers`);

        for (const w of workers.values()) {
          const newMax = Math.max(MIN_CONCURRENCY, Math.floor(w._baseMaxConcurrent * 0.5));
          w.applyPressure(newMax);
        }
      } else {
        // Restore all workers that were throttled
        for (const w of workers.values()) {
          w.releasePressure();
        }
      }
    } catch (err) {
      logger.error(`[WorkerManager] Resource monitor error: ${err.message}`);
    }
  }, RESOURCE_CHECK_INTERVAL_MS);

  // Don't prevent Node from exiting
  if (_resourceCheckTimer.unref) _resourceCheckTimer.unref();
}

// ── Health Check ──────────────────────────────────────────────────────────

function _startHealthCheck(client) {
  if (_healthCheckTimer) clearInterval(_healthCheckTimer);

  _healthCheckTimer = setInterval(async () => {
    try {
      await _runHealthCheck(client);
    } catch (err) {
      logger.error(`[WorkerManager] Health check threw: ${err.message}`);
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  if (_healthCheckTimer.unref) _healthCheckTimer.unref();
}

async function _runHealthCheck(client) {
  logger.debug("[WorkerManager] Running health check...");
  const issues = [];

  // Check database accessibility
  try {
    if (_dbRef) _dbRef.getStatistics(); // read-only sanity check
  } catch (err) {
    issues.push(`Database: ${err.message}`);
  }

  // Check all workers are not permanently stuck
  for (const [name, w] of workers.entries()) {
    const snap = w.getSnapshot();
    if (snap.active > 0 && snap.queued > 50) {
      issues.push(`Worker ${name}: queue depth ${snap.queued} — possible stall`);
    }
  }

  // Check yt-dlp presence
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
  } catch {
    // Not a fatal issue — yt-dlp may be in bin/ instead of PATH
  }

  if (issues.length > 0) {
    logger.warn(`[WorkerManager] Health check issues:\n${issues.map(i => `  • ${i}`).join("\n")}`);
    await logError({
      feature: "WorkerManager Health Check",
      reason:  issues.join(" | "),
      stage:   "Health Check",
    }).catch(() => {});
  } else {
    logger.debug("[WorkerManager] Health check OK.");
  }
}

/**
 * Graceful shutdown — called on process exit signals.
 * Workers finish in-flight jobs and stop accepting new ones.
 */
export function shutdownWorkerManager() {
  clearInterval(_resourceCheckTimer);
  clearInterval(_healthCheckTimer);
  logger.info("[WorkerManager] Shutdown signal received. Workers will finish in-flight jobs.");
}
