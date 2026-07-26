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

import os           from "node:os";
import fs           from "node:fs";
import { execFile }  from "node:child_process";
import { promisify } from "node:util";
import { logger }   from "../../utils/logger.js";
import { logError } from "../../utils/errorLogger.js";

const _execFileAsync = promisify(execFile);
import { PlatformWorker } from "./platformWorker.js";
import {
  WORKER_DEFAULTS,
  MEMORY_THROTTLE_THRESHOLD,
  CPU_THROTTLE_THRESHOLD,
  HEALTH_CHECK_INTERVAL_MS,
  RESOURCE_CHECK_INTERVAL_MS,
  MIN_CONCURRENCY,
  DISK_WARN_THRESHOLD,
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

/**
 * Hysteresis band below the throttle threshold.
 * Concurrency is only restored once usage drops this far below the trigger
 * point, preventing rapid oscillation when load hovers at the boundary.
 */
const HYSTERESIS = 0.05; // 5 percentage-point band
const RESTORE_MEM_THRESHOLD = MEMORY_THROTTLE_THRESHOLD - HYSTERESIS;
const RESTORE_CPU_THRESHOLD = CPU_THROTTLE_THRESHOLD     - HYSTERESIS;

/** True while any resource is above its trigger threshold. */
let _underPressure = false;

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
        if (!_underPressure) {
          if (memPressure) logger.warn(`[WorkerManager] Memory pressure: ${(memUsage * 100).toFixed(1)}% — throttling workers`);
          if (cpuPressure) logger.warn(`[WorkerManager] CPU pressure: ${(cpuUsage * 100).toFixed(1)}% — throttling workers`);
        }
        _underPressure = true;
        for (const w of workers.values()) {
          const newMax = Math.max(MIN_CONCURRENCY, Math.floor(w._baseMaxConcurrent * 0.5));
          w.applyPressure(newMax);
        }
      } else if (_underPressure) {
        // Hysteresis: only restore when usage drops below the restore threshold,
        // not the moment it dips under the trigger threshold. This prevents
        // rapid oscillation when load hovers near the boundary.
        const memSafe = memUsage < RESTORE_MEM_THRESHOLD;
        const cpuSafe = cpuUsage < RESTORE_CPU_THRESHOLD;
        if (memSafe && cpuSafe) {
          _underPressure = false;
          logger.info(`[WorkerManager] Resource pressure lifted (mem=${(memUsage * 100).toFixed(1)}% cpu=${(cpuUsage * 100).toFixed(1)}%) — restoring concurrency`);
          for (const w of workers.values()) {
            w.releasePressure();
          }
        }
      } else {
        // Never under pressure — ensure workers run at full concurrency (idempotent).
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

/**
 * How long a worker may remain active with no job completions before it is
 * considered stalled and restarted automatically.
 *
 * BoomBox workers (timeoutMs = 0) rely on stage-level guards up to
 * 5 min × 3 retries = 15 min max, so we allow 20 min before declaring a stall.
 * Workers with an explicit timeoutMs use 3× that value instead.
 */
const BOOMBOX_STALL_MS = 20 * 60_000; // 20 minutes

function _workerStallThresholdMs(w) {
  return w.timeoutMs > 0 ? w.timeoutMs * 3 : BOOMBOX_STALL_MS;
}

async function _checkDiskSpace() {
  try {
    const tmpDir = os.tmpdir();
    const stat   = await fs.promises.statfs(tmpDir);
    const total  = stat.blocks  * stat.bsize;
    const free   = stat.bfree   * stat.bsize;
    const used   = (total - free) / total;
    return { used, total, free };
  } catch {
    return null; // statfs not available on this platform — skip
  }
}

async function _runHealthCheck(client) {
  logger.debug("[WorkerManager] Running health check...");
  const issues  = [];
  const actions = []; // descriptions of auto-recovery actions taken

  // ── Database accessibility ────────────────────────────────────────────────
  try {
    if (_dbRef) _dbRef.getStatistics(); // read-only sanity check
  } catch (err) {
    issues.push(`Database: ${err.message}`);
    // No module-level restart possible for a flat-file DB — log clearly so the
    // operator knows data may be stale, but don't crash the process.
    logger.error(`[WorkerManager] ⚠ Database health check failed: ${err.message}`);
  }

  // ── Worker stall detection + auto-restart ─────────────────────────────────
  // A worker is stalled when it has active jobs but its lastActivityAt hasn't
  // advanced for longer than its stall threshold (3× job timeout, or 20 min
  // for BoomBox workers whose stage guards own the deadline).
  for (const [name, w] of workers.entries()) {
    const snap         = w.getSnapshot();
    const stallMs      = _workerStallThresholdMs(w);
    const idleMs       = Date.now() - (snap.lastActivityAt ?? 0);
    const isStalled    = snap.active > 0 && idleMs > stallMs;

    if (isStalled) {
      issues.push(`Worker ${name}: stalled (active=${snap.active}, no activity for ${Math.round(idleMs / 60_000)}min)`);
      logger.warn(`[WorkerManager] 🔄 Auto-restarting stalled worker "${name}" (idle ${Math.round(idleMs / 60_000)}min, threshold ${Math.round(stallMs / 60_000)}min)`);
      try {
        w.restart();
        actions.push(`Restarted stalled worker "${name}"`);
      } catch (err) {
        logger.error(`[WorkerManager] Failed to restart worker "${name}": ${err.message}`);
      }
    } else if (snap.queued > 50) {
      // Deep queue is a warning signal even if activity is recent — log only.
      issues.push(`Worker ${name}: queue depth ${snap.queued} (active=${snap.active})`);
    }
  }

  // ── yt-dlp presence ───────────────────────────────────────────────────────
  try {
    await _execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
  } catch {
    // Not fatal — yt-dlp may be in bin/ instead of PATH; the binary resolver
    // in ytmp3gg.js handles this path automatically.
  }

  // ── Disk space ────────────────────────────────────────────────────────────
  const disk = await _checkDiskSpace();
  if (disk !== null && disk.used >= DISK_WARN_THRESHOLD) {
    const pct = (disk.used * 100).toFixed(1);
    const freeMB = (disk.free / 1024 / 1024).toFixed(0);
    issues.push(`Disk: ${pct}% used (${freeMB} MB free) — cleanup triggered`);
    logger.warn(`[WorkerManager] ⚠ Disk usage ${pct}% — only ${freeMB} MB free in ${os.tmpdir()} — triggering BoomBox temp cleanup`);
    // Trigger stale temp cleanup to free disk space under pressure
    try {
      const { cleanupStaleBoomBoxTempDirs } = await import("../boombox/handler.js");
      cleanupStaleBoomBoxTempDirs();
      actions.push("Triggered BoomBox temp cleanup (disk pressure)");
    } catch (cleanupErr) {
      logger.warn(`[WorkerManager] Disk-pressure cleanup failed: ${cleanupErr.message}`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  if (issues.length > 0) {
    const recovered = actions.length > 0 ? ` | Recovery: ${actions.join("; ")}` : "";
    logger.warn(`[WorkerManager] Health check issues:\n${issues.map(i => `  • ${i}`).join("\n")}${recovered}`);
    await logError({
      feature:  "WorkerManager Health Check",
      reason:   issues.join(" | "),
      stage:    "Health Check",
      action:   actions.join("; ") || "No auto-recovery taken",
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
