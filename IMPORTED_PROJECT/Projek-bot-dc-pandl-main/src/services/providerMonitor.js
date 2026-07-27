/**
 * providerMonitor.js — Persistent provider monitoring for BoomBox.
 *
 * Tracks per-provider statistics that survive restarts:
 *   • status (ONLINE / OFFLINE / RATE_LIMITED)
 *   • successCount / failureCount
 *   • avgResponseMs (rolling 20-sample average)
 *   • lastError / lastErrorCategory
 *   • lastOnlineAt / lastFailureAt
 *
 * Dashboard: only shows providers that are currently problematic —
 * no noise from healthy providers.
 *
 * Storage: boombox-db.json via BoomBoxDB.getProviderMonitor / setProviderMonitor
 *
 * Exports:
 *   initProviderMonitor(db)        — call once after DB is ready
 *   recordProviderResult(key, { success, durationMs, errorCategory, reason })
 *   getProviderStats()             — all providers
 *   getProblematicProviderStats()  — only OFFLINE / RATE_LIMITED / high-error-rate
 *   formatMonitoringReport()       — human-readable string for Discord
 */

import { logger }   from "../utils/logger.js";
import { getAllStatuses, getProblematicProviders } from "./providerHealth.js";

let _db = null;

/** Call once after BoomBoxDB is initialized. */
export function initProviderMonitor(db) {
  _db = db;
  logger.info("[ProviderMonitor] Initialized.");
}

// ── In-memory rolling average helpers ────────────────────────────────────────

/** @type {Map<string, number[]>} providerKey → last N response times (ms) */
const _responseTimes = new Map();
const ROLLING_WINDOW = 20;

function _pushResponseTime(key, ms) {
  if (!_responseTimes.has(key)) _responseTimes.set(key, []);
  const arr = _responseTimes.get(key);
  arr.push(ms);
  if (arr.length > ROLLING_WINDOW) arr.shift();
}

function _avgResponseTime(key) {
  const arr = _responseTimes.get(key) ?? [];
  if (arr.length === 0) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function _load() {
  try {
    return _db?.getProviderMonitor?.() ?? {};
  } catch {
    return {};
  }
}

function _save(data) {
  try {
    _db?.setProviderMonitor?.(data);
  } catch (e) {
    logger.warn(`[ProviderMonitor] Failed to persist stats: ${e.message}`);
  }
}

function _entry(data, key) {
  if (!data[key]) {
    data[key] = {
      successCount:  0,
      failureCount:  0,
      lastError:     null,
      lastErrorCategory: null,
      lastOnlineAt:  null,
      lastFailureAt: null,
    };
  }
  return data[key];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record the result of one provider attempt.
 *
 * @param {string} key              Provider key (e.g. "yt-dlp-youtube")
 * @param {{
 *   success:       boolean,
 *   durationMs?:   number,    response time (ms) — for averaging
 *   reason?:       string,    error message (only for failure)
 *   errorCategory?: string,   from ERROR_CATEGORY
 * }} result
 */
export function recordProviderResult(key, { success, durationMs, reason, errorCategory } = {}) {
  if (!_db) return; // not yet initialized

  const data  = _load();
  const entry = _entry(data, key);

  if (success) {
    entry.successCount++;
    entry.lastOnlineAt = Date.now();
  } else {
    entry.failureCount++;
    entry.lastError         = reason ?? null;
    entry.lastErrorCategory = errorCategory ?? null;
    entry.lastFailureAt     = Date.now();
  }

  if (typeof durationMs === "number" && durationMs > 0) {
    _pushResponseTime(key, durationMs);
    entry.avgResponseMs = _avgResponseTime(key);
  }

  _save(data);
}

/**
 * Returns stats for ALL providers (merging in-memory health + persistent stats).
 * @returns {Record<string, object>}
 */
export function getProviderStats() {
  const healthStatuses = getAllStatuses();
  const persistedStats = _load();

  const result = {};

  // Merge health + persistent data
  const allKeys = new Set([
    ...Object.keys(healthStatuses),
    ...Object.keys(persistedStats),
  ]);

  for (const label of allKeys) {
    // healthStatuses uses label (human-readable), persistedStats uses raw key
    const health = healthStatuses[label] ?? {};
    const stored = persistedStats[label] ?? persistedStats[Object.keys(persistedStats).find(k => k === label)] ?? {};
    result[label] = {
      status:            health.status ?? "ONLINE",
      consecutiveFailures: health.consecutiveFailures ?? 0,
      lastErrorCategory: health.lastErrorCategory ?? stored.lastErrorCategory ?? null,
      lastError:         health.lastError ?? stored.lastError ?? null,
      lastOnlineAt:      stored.lastOnlineAt ?? null,
      lastFailureAt:     stored.lastFailureAt ?? null,
      successCount:      (health.totalSuccess ?? 0) + (stored.successCount ?? 0),
      failureCount:      (health.totalFailure ?? 0) + (stored.failureCount ?? 0),
      avgResponseMs:     stored.avgResponseMs ?? null,
      isRateLimited:     health.isRateLimited ?? false,
    };
  }

  return result;
}

/**
 * Returns only providers that are currently problematic.
 * Used by monitoring dashboards — no noise from healthy providers.
 * @returns {Array<object>}
 */
export function getProblematicProviderStats() {
  const problematic = getProblematicProviders(); // from providerHealth.js
  const stored      = _load();

  return problematic.map(p => ({
    ...p,
    successCount:  stored[p.label]?.successCount  ?? 0,
    failureCount:  stored[p.label]?.failureCount  ?? 0,
    avgResponseMs: stored[p.label]?.avgResponseMs ?? null,
    lastOnlineAt:  stored[p.label]?.lastOnlineAt  ?? null,
  }));
}

/**
 * Returns a human-readable Discord-ready monitoring report.
 * Only shows problematic providers — empty string if all OK.
 *
 * @returns {string}
 */
export function formatMonitoringReport() {
  const problematic = getProblematicProviderStats();

  if (problematic.length === 0) {
    return "✅ **Semua provider BoomBox normal.** Tidak ada masalah terdeteksi.";
  }

  const lines = [
    `⚠️ **Provider Monitor — ${problematic.length} masalah terdeteksi**`,
    "━━━━━━━━━━━━━━━━━━",
  ];

  for (const p of problematic) {
    const statusIcon = p.status === "OFFLINE"
      ? "🔴"
      : p.status === "RATE_LIMITED"
        ? "🟡"
        : "🟠";

    const sinceStr = p.since
      ? `sejak <t:${Math.floor(p.since / 1000)}:R>`
      : "";

    const lastOnlineStr = p.lastOnlineAt
      ? `terakhir online <t:${Math.floor(p.lastOnlineAt / 1000)}:R>`
      : "belum pernah online sejak start";

    lines.push(
      `${statusIcon} **${p.label}** — \`${p.status}\``,
      `  Kategori: \`${p.category ?? "Unknown"}\` ${sinceStr}`,
      `  Error: ${(p.reason ?? "-").slice(0, 100)}`,
      `  ${lastOnlineStr} | Gagal: ${p.failureCount ?? p.failures ?? 0}x`,
    );
  }

  lines.push("━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}
