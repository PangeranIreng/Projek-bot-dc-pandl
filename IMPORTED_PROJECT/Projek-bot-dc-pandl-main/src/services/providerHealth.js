/**
 * providerHealth.js — Circuit breaker / health tracker for BoomBox's
 * download providers (yt-dlp for YouTube, yt-dlp for TikTok, ytdl-core,
 * kaizenapi).
 *
 * V2 Improvements:
 *   - Error categorization: errors are classified before affecting health state
 *   - Smarter OFFLINE decisions: only true connectivity failures → OFFLINE
 *   - CookieError / AntiBot / FormatNotAvailable do NOT mark provider OFFLINE
 *   - RateLimit gets short cooldown, not full OFFLINE
 *   - Per-category failure thresholds
 */

import { logError } from "../utils/errorLogger.js";
import { logger }   from "../utils/logger.js";

// ── Error Categories ──────────────────────────────────────────────────────────

export const ERROR_CATEGORY = {
  NETWORK:             "NetworkError",        // timeout, ECONNRESET, connection failed
  HTTP:                "HTTPError",           // HTTP 4xx/5xx (not 429)
  RATE_LIMIT:          "RateLimit",           // HTTP 429, too many requests
  COOKIE:              "CookieError",         // expired/invalid cookies
  ANTI_BOT:            "AntiBot",             // YouTube bot verification challenge
  FORMAT_UNAVAILABLE:  "FormatNotAvailable",  // requested format/quality not available
  UNSUPPORTED_VIDEO:   "UnsupportedVideo",    // private, deleted, DRM, region-blocked
  METADATA:            "MetadataError",       // can't extract metadata
  UNKNOWN:             "Unknown",             // anything else
};

/**
 * Classify an error message into a category.
 * @param {string} message
 * @returns {string} One of ERROR_CATEGORY values
 */
export function classifyError(message) {
  const m = String(message).toLowerCase();

  // Anti-bot — NOT a true provider failure; just rotate client method
  if (m.includes("not a bot") || m.includes("not a robot") ||
      m.includes("confirm you") || m.includes("anti-bot"))
    return ERROR_CATEGORY.ANTI_BOT;

  // Cookie errors — problem with our credential file, not the provider
  if (m.includes("cookie") && (
      m.includes("expired") || m.includes("kedaluwarsa") ||
      m.includes("invalid") || m.includes("malformed") ||
      m.includes("netscape http cookie")))
    return ERROR_CATEGORY.COOKIE;

  // Rate limit — short backoff, not OFFLINE
  if (m.includes("429") || m.includes("rate limit") || m.includes("too many request"))
    return ERROR_CATEGORY.RATE_LIMIT;

  // Unsupported / permanent video issues — not a provider connectivity problem
  if (m.includes("dihapus") || m.includes("private") || m.includes("privat") ||
      m.includes("live stream") || m.includes("siaran langsung") ||
      m.includes("drm") || m.includes("widevine") || m.includes("region block") ||
      m.includes("copyright") || m.includes("age-restrict") || m.includes("age restrict") ||
      m.includes("login required") || m.includes("sign in") ||
      m.includes("has been removed") || m.includes("video_removed"))
    return ERROR_CATEGORY.UNSUPPORTED_VIDEO;

  // Format not available — provider is working, just doesn't have this quality
  if (m.includes("format not available") || m.includes("requested format") ||
      m.includes("no video formats") || m.includes("no audio formats") ||
      m.includes("format unavailable"))
    return ERROR_CATEGORY.FORMAT_UNAVAILABLE;

  // Metadata extraction failure
  if (m.includes("extractor") || m.includes("extraction failed") ||
      m.includes("unable to extract") || m.includes("metadata"))
    return ERROR_CATEGORY.METADATA;

  // Network / timeout — true connectivity failure
  if (m.includes("timeout") || m.includes("timed out") ||
      m.includes("econnreset") || m.includes("connection reset") ||
      m.includes("socket") || m.includes("etimedout") ||
      m.includes("network error") || m.includes("enotfound") ||
      m.includes("econnrefused") || m.includes("econnaborted"))
    return ERROR_CATEGORY.NETWORK;

  // HTTP errors
  if (m.includes("403") || m.includes("forbidden") ||
      m.includes("401") || m.includes("404") || m.includes("500") ||
      m.includes("502") || m.includes("503") || m.includes("http error"))
    return ERROR_CATEGORY.HTTP;

  return ERROR_CATEGORY.UNKNOWN;
}

// ── OFFLINE threshold per category ────────────────────────────────────────────

/**
 * Categories that should NEVER trigger OFFLINE state on the provider.
 * These are either transient (RateLimit), client-side (Cookie, AntiBot),
 * or video-specific (Format, UnsupportedVideo) — the provider itself is fine.
 */
const NO_OFFLINE_CATEGORIES = new Set([
  ERROR_CATEGORY.COOKIE,
  ERROR_CATEGORY.ANTI_BOT,
  ERROR_CATEGORY.FORMAT_UNAVAILABLE,
  ERROR_CATEGORY.UNSUPPORTED_VIDEO,
  ERROR_CATEGORY.RATE_LIMIT,
]);

/** Number of consecutive connectivity failures before marking OFFLINE. */
const FAILURE_THRESHOLD = {
  [ERROR_CATEGORY.NETWORK]:  5,  // true outage — require 5 in a row
  [ERROR_CATEGORY.HTTP]:     5,  // server errors
  [ERROR_CATEGORY.METADATA]: 5,  // extraction errors
  [ERROR_CATEGORY.UNKNOWN]:  8,  // unknown — be tolerant
};

/** Default threshold when category has no specific entry. */
const DEFAULT_THRESHOLD = 8;

/** Auto-recovery window (ms) — how long a provider stays OFFLINE before
 *  we allow a probe attempt again. */
const RECOVERY_MS = 5 * 60 * 1000; // 5 minutes

/** Human-friendly labels for Error Log / monitoring display. */
const PROVIDER_LABELS = {
  "yt-dlp-youtube": "yt-dlp (YouTube)",
  "yt-dlp-tiktok":  "yt-dlp (TikTok)",
  "ytdl-core":      "@distube/ytdl-core (Backup API 1)",
  "kaizenapi":      "kaizenapi.my.id (Backup API 2)",
  "top4top":        "top4top.io (Uploader)",
  "spotify-oembed": "Spotify oEmbed API",
};

/** @type {Map<string, {
 *   status: "ONLINE"|"OFFLINE",
 *   consecutiveFailures: number,
 *   lastError: string|null,
 *   lastErrorCategory: string|null,
 *   offlineSince: number|null,
 *   totalSuccess: number,
 *   totalFailure: number,
 *   totalTimeouts: number,
 *   totalSkipped: number,
 *   totalAntiBotHits: number,
 *   totalCookieErrors: number,
 *   totalRateLimitHits: number,
 * }>} */
const providers = new Map();

function _entry(providerKey) {
  if (!providers.has(providerKey)) {
    providers.set(providerKey, {
      status:              "ONLINE",
      consecutiveFailures: 0,
      lastError:           null,
      lastErrorCategory:   null,
      offlineSince:        null,
      totalSuccess:        0,
      totalFailure:        0,
      totalTimeouts:       0,
      totalSkipped:        0,
      totalAntiBotHits:    0,
      totalCookieErrors:   0,
      totalRateLimitHits:  0,
    });
  }
  return providers.get(providerKey);
}

function _label(providerKey) {
  return PROVIDER_LABELS[providerKey] || providerKey;
}

// ── Rate-limit backoff tracking ───────────────────────────────────────────────
// Providers that hit rate-limits get a short backoff (NOT full OFFLINE status).
// We track the backoff expiry separately from the OFFLINE circuit breaker.

/** @type {Map<string, number>} providerKey → timestamp when backoff expires */
const _rateLimitBackoff = new Map();

/** Short backoff for rate limits (2 min) — much shorter than OFFLINE (5 min). */
const RATE_LIMIT_BACKOFF_MS = 2 * 60 * 1000;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Should the caller skip this provider entirely right now?
 * Returns false (don't skip) once the recovery window has elapsed, allowing
 * exactly the next caller(s) through as a recovery probe.
 */
export function shouldSkip(providerKey) {
  // Check rate-limit backoff first (short-circuit, not OFFLINE)
  const rlExp = _rateLimitBackoff.get(providerKey);
  if (rlExp && Date.now() < rlExp) {
    logger.debug(`[ProviderHealth] ${_label(providerKey)} — rate-limit backoff active (${Math.round((rlExp - Date.now()) / 1000)}s remaining)`);
    return true;
  }

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
  e.lastErrorCategory = null;
  e.totalSuccess++;

  // Also clear any rate-limit backoff on success
  _rateLimitBackoff.delete(providerKey);

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
 * Record a failed call to `providerKey`.
 * Categorizes the error and only marks OFFLINE for true connectivity failures.
 *
 * @param {string} providerKey
 * @param {{ reason: string, isTimeout?: boolean, category?: string }} info
 */
export function recordFailure(providerKey, { reason, isTimeout = false, category } = {}) {
  const e = _entry(providerKey);
  const errorMsg = reason ?? "Unknown error";
  const cat = category ?? classifyError(errorMsg);

  e.lastError = errorMsg;
  e.lastErrorCategory = cat;
  e.totalFailure++;
  if (isTimeout) e.totalTimeouts++;

  // Track category-specific counters
  if (cat === ERROR_CATEGORY.ANTI_BOT)   e.totalAntiBotHits++;
  if (cat === ERROR_CATEGORY.COOKIE)     e.totalCookieErrors++;
  if (cat === ERROR_CATEGORY.RATE_LIMIT) e.totalRateLimitHits++;

  // Rate-limit: set short backoff but don't count towards OFFLINE threshold
  if (cat === ERROR_CATEGORY.RATE_LIMIT) {
    const exp = Date.now() + RATE_LIMIT_BACKOFF_MS;
    _rateLimitBackoff.set(providerKey, exp);
    logger.warn(`[ProviderHealth] ${_label(providerKey)} — Rate Limited: short backoff ${RATE_LIMIT_BACKOFF_MS / 60000}min (not OFFLINE)`);
    return;
  }

  // Categories that should never trigger OFFLINE — just log and return
  if (NO_OFFLINE_CATEGORIES.has(cat)) {
    logger.debug(`[ProviderHealth] ${_label(providerKey)} — failure ignored for OFFLINE threshold (category: ${cat}): ${errorMsg.slice(0, 120)}`);
    return;
  }

  // True connectivity failure — count towards OFFLINE threshold
  e.consecutiveFailures++;

  const threshold = FAILURE_THRESHOLD[cat] ?? DEFAULT_THRESHOLD;

  if (e.status === "ONLINE" && e.consecutiveFailures >= threshold) {
    e.status = "OFFLINE";
    e.offlineSince = Date.now();
    logger.warn(`[ProviderHealth] ${_label(providerKey)} — ${e.consecutiveFailures} consecutive ${cat} failures, status OFFLINE for ${RECOVERY_MS / 60000}min`);
    logError({
      feature:       "BoomBox",
      provider:      _label(providerKey),
      status:        "OFFLINE",
      reason:        `${cat}: ${e.consecutiveFailures}x berturut-turut — ${e.lastError}`,
      stage:         "Provider Health Check",
      action:        "Beralih ke provider berikutnya; auto retry setelah 5 menit",
      errorCategory: cat,
    }).catch(() => {});
  } else if (e.status === "OFFLINE") {
    // Failed recovery probe — reset the cooldown window
    e.offlineSince = Date.now();
    logger.debug(`[ProviderHealth] ${_label(providerKey)} — recovery probe failed (${cat}), OFFLINE for another ${RECOVERY_MS / 60000}min`);
  } else {
    // ONLINE, below threshold — just log the count
    logger.debug(`[ProviderHealth] ${_label(providerKey)} — consecutive failures: ${e.consecutiveFailures}/${threshold} (${cat})`);
  }
}

/** @returns {object} snapshot of one provider's stats */
export function getStatus(providerKey) {
  return { ..._entry(providerKey) };
}

/**
 * @returns {Record<string, object>} snapshot of every provider seen so far,
 * keyed by its label — used by monitoring commands and dashboards.
 */
export function getAllStatuses() {
  const out = {};
  for (const [key, value] of providers) {
    const rlExp = _rateLimitBackoff.get(key);
    out[_label(key)] = {
      ...value,
      rateLimitUntil: rlExp && Date.now() < rlExp ? rlExp : null,
      isRateLimited:  Boolean(rlExp && Date.now() < rlExp),
    };
  }
  return out;
}

/**
 * Returns only providers that are currently problematic (OFFLINE or rate-limited).
 * Used by monitoring dashboards to show only what needs attention.
 * @returns {Array<{ label: string, status: string, reason: string|null, since: number|null }>}
 */
export function getProblematicProviders() {
  const results = [];
  for (const [key, e] of providers) {
    const rlExp = _rateLimitBackoff.get(key);
    const isRateLimited = Boolean(rlExp && Date.now() < rlExp);

    if (e.status === "OFFLINE") {
      results.push({
        key,
        label:    _label(key),
        status:   "OFFLINE",
        category: e.lastErrorCategory,
        reason:   e.lastError,
        since:    e.offlineSince,
        failures: e.consecutiveFailures,
      });
    } else if (isRateLimited) {
      results.push({
        key,
        label:    _label(key),
        status:   "RATE_LIMITED",
        category: ERROR_CATEGORY.RATE_LIMIT,
        reason:   "Rate limit backoff aktif",
        since:    rlExp - RATE_LIMIT_BACKOFF_MS,
        failures: e.totalRateLimitHits,
      });
    }
  }
  return results;
}

/**
 * Reset a provider back to ONLINE manually (e.g. after admin command).
 * @param {string} providerKey
 */
export function resetProvider(providerKey) {
  const e = _entry(providerKey);
  e.status              = "ONLINE";
  e.consecutiveFailures = 0;
  e.lastError           = null;
  e.lastErrorCategory   = null;
  e.offlineSince        = null;
  _rateLimitBackoff.delete(providerKey);
  logger.info(`[ProviderHealth] ${_label(providerKey)} — manually reset to ONLINE`);
}
