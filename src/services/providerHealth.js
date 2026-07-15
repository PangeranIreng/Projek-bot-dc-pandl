/**
 * providerHealth.js — Circuit breaker / health tracker for BoomBox's
 * download providers (yt-dlp for YouTube, yt-dlp for TikTok, ytdl-core,
 * kaizenapi).
 *
 * Per spec: if a provider fails 5 times in a row, mark it OFFLINE and stop
 * wasting time trying it — skip straight to the next provider in the
 * fallback chain. After a cooldown window, automatically allow one probe
 * attempt again; if it succeeds the provider goes back ONLINE, if it fails
 * the cooldown resets. No restart, no manual command needed.
 *
 * This module is intentionally dependency-free (no imports from ytmp3gg.js
 * etc.) so it can be wired into any provider without circular imports.
 */

import { logError } from "../utils/errorLogger.js";
import { logger }   from "../utils/logger.js";

const FAILURE_THRESHOLD = 5;              // consecutive failures -> OFFLINE
const RECOVERY_MS       = 10 * 60 * 1000; // 10 minutes before auto-retry

/** Human-friendly labels for Error Log / monitoring display. */
const PROVIDER_LABELS = {
  "yt-dlp-youtube": "yt-dlp (YouTube)",
  "yt-dlp-tiktok":  "yt-dlp (TikTok)",
  "ytdl-core":      "@distube/ytdl-core (Backup API 1)",
  "kaizenapi":      "kaizenapi.my.id (Backup API 2)",
};

/** @type {Map<string, { status: "ONLINE"|"OFFLINE", consecutiveFailures: number,
 *   lastError: string|null, offlineSince: number|null, totalSuccess: number,
 *   totalFailure: number, totalTimeouts: number, totalSkipped: number }>} */
const providers = new Map();

function _entry(providerKey) {
  if (!providers.has(providerKey)) {
    providers.set(providerKey, {
      status: "ONLINE",
      consecutiveFailures: 0,
      lastError: null,
      offlineSince: null,
      totalSuccess: 0,
      totalFailure: 0,
      totalTimeouts: 0,
      totalSkipped: 0,
    });
  }
  return providers.get(providerKey);
}

function _label(providerKey) {
  return PROVIDER_LABELS[providerKey] || providerKey;
}

/**
 * Should the caller skip this provider entirely right now?
 * Returns false (don't skip) once the recovery window has elapsed, allowing
 * exactly the next caller(s) through as a recovery probe.
 */
export function shouldSkip(providerKey) {
  const e = _entry(providerKey);
  if (e.status !== "OFFLINE") return false;

  const elapsed = Date.now() - (e.offlineSince ?? 0);
  if (elapsed >= RECOVERY_MS) {
    logger.info(`[ProviderHealth] ${_label(providerKey)} — recovery window elapsed, allowing a probe attempt`);
    return false; // let this call through as a recovery probe
  }

  e.totalSkipped++;
  return true;
}

/** Record a successful call to `providerKey`. Recovers it from OFFLINE if needed. */
export function recordSuccess(providerKey) {
  const e = _entry(providerKey);
  const wasOffline = e.status === "OFFLINE";
  e.consecutiveFailures = 0;
  e.lastError = null;
  e.totalSuccess++;

  if (wasOffline) {
    e.status = "ONLINE";
    e.offlineSince = null;
    logger.info(`[ProviderHealth] ${_label(providerKey)} — recovery probe succeeded, status ONLINE`);
    logError({
      feature:  "BoomBox",
      provider: _label(providerKey),
      status:   "ONLINE",
      reason:   "Recovery probe berhasil setelah masa cooldown",
      stage:    "Provider Health Check",
      action:   "Provider kembali digunakan secara normal",
    }).catch(() => {});
  }
}

/**
 * Record a failed call to `providerKey`. Marks it OFFLINE once
 * FAILURE_THRESHOLD consecutive failures are reached.
 * @param {string} providerKey
 * @param {{ reason: string, isTimeout?: boolean }} info
 */
export function recordFailure(providerKey, { reason, isTimeout = false } = {}) {
  const e = _entry(providerKey);
  e.consecutiveFailures++;
  e.lastError = reason ?? "Unknown error";
  e.totalFailure++;
  if (isTimeout) e.totalTimeouts++;

  if (e.status === "ONLINE" && e.consecutiveFailures >= FAILURE_THRESHOLD) {
    e.status = "OFFLINE";
    e.offlineSince = Date.now();
    logger.warn(`[ProviderHealth] ${_label(providerKey)} — ${e.consecutiveFailures} consecutive failures, status OFFLINE for ${RECOVERY_MS / 60000}min`);
    logError({
      feature:  "BoomBox",
      provider: _label(providerKey),
      status:   "OFFLINE",
      reason:   `Consecutive failure ${e.consecutiveFailures}x — ${e.lastError}`,
      stage:    "Provider Health Check",
      action:   "Beralih ke provider berikutnya; auto retry setelah 10 menit",
    }).catch(() => {});
  } else if (e.status === "OFFLINE") {
    // Failed recovery probe — stay offline, push the cooldown window back out.
    e.offlineSince = Date.now();
    logger.debug(`[ProviderHealth] ${_label(providerKey)} — recovery probe failed, remaining OFFLINE for another ${RECOVERY_MS / 60000}min`);
  }
}

/** @returns {{status:string, consecutiveFailures:number, lastError:string|null,
 *   offlineSince:number|null, totalSuccess:number, totalFailure:number,
 *   totalTimeouts:number, totalSkipped:number}} */
export function getStatus(providerKey) {
  return { ..._entry(providerKey) };
}

/** @returns {Record<string, ReturnType<typeof getStatus>>} snapshot of every
 * provider seen so far, keyed by its label — used by the !hesu monitoring
 * command so operators can see provider health without a separate/spammy
 * dashboard. */
export function getAllStatuses() {
  const out = {};
  for (const [key, value] of providers) {
    out[_label(key)] = { ...value };
  }
  return out;
}
