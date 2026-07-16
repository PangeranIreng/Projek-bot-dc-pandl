/**
 * boomboxCache.js — VideoID-keyed two-layer BoomBox cache.
 *
 * Layer 1 — Result cache
 *   Key   : videoId  (stable across different URL formats of same video)
 *   Value : { boomboxUrl, ytResult, hitCount, lastUsed, expire }
 *   TTL   : 72 h    Max: 500 entries
 *
 * Layer 2 — Metadata cache
 *   Key   : videoId
 *   Value : { title, duration, thumbnail, uploader }
 *   TTL   : 24 h    Max: 500 entries
 *
 * Auto-clean: setInterval every 6 h — evicts entries unused for > AUTO_CLEAN_DAYS.
 *
 * VideoID extraction:
 *   YouTube   yt:{11-char id}
 *   TikTok    tt:{numeric id}  |  tt:{normalized url}
 *   Spotify   sp:{track id}
 *   Other     url:{normalized url}
 *
 * Exports:
 *   extractVideoId(url, platform)             → string
 *   getCachedResult(videoId)                  → entry | null  (updates hitCount)
 *   setCachedResult(videoId, { boomboxUrl, ytResult }) → void
 *   getCachedMeta(videoId)                    → meta | null
 *   setCachedMeta(videoId, meta)              → void
 *   getCacheStats()                           → { resultSize, metaSize, hits, misses }
 */

import { logger } from "../utils/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const RESULT_TTL_MS         = 72 * 60 * 60 * 1000;  // 72 hours
const META_TTL_MS           = 24 * 60 * 60 * 1000;  // 24 hours
const MAX_RESULT_CACHE      = 500;
const MAX_META_CACHE        = 500;
const AUTO_CLEAN_DAYS       = 90;                    // evict entries unused ≥ 90 days
const AUTO_CLEAN_INTERVAL   = 6 * 60 * 60 * 1000;   // run cleanup every 6 h

// ── In-memory stores ──────────────────────────────────────────────────────────

/** @type {Map<string, {boomboxUrl:string, ytResult:object, hitCount:number, lastUsed:number, expire:number}>} */
const _resultCache = new Map();

/** @type {Map<string, {title:string|null, duration:number|null, thumbnail:string|null, uploader:string|null, cachedAt:number}>} */
const _metaCache   = new Map();

// ── Stats counters ────────────────────────────────────────────────────────────

let _hits   = 0;
let _misses = 0;

// ── VideoID extraction ────────────────────────────────────────────────────────

/**
 * Extract a stable, platform-specific cache key from a URL.
 * Stable means the same video always returns the same key regardless of which
 * URL variant was sent (e.g. youtu.be vs youtube.com/watch?v=).
 *
 * @param {string} url
 * @param {string} [platform]  "YouTube" | "TikTok" | "Spotify" | other
 * @returns {string}
 */
export function extractVideoId(url, platform) {
  const s = String(url);

  // ── YouTube ───────────────────────────────────────────────────────────────
  if (platform === "YouTube" || /youtu/i.test(s)) {
    const m = s.match(
      /(?:v=|\/shorts\/|\/live\/|youtu\.be\/|\/embed\/|\/v\/)([a-zA-Z0-9_-]{11})/
    );
    if (m?.[1]) return `yt:${m[1]}`;
  }

  // ── TikTok ────────────────────────────────────────────────────────────────
  if (platform === "TikTok" || /tiktok/i.test(s)) {
    const m = s.match(/\/video\/(\d{10,})/);
    if (m?.[1]) return `tt:${m[1]}`;
    // Short redirect URLs (vm.tiktok.com, vt.tiktok.com) — normalize path only
    const norm = s.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    return `tt:${norm}`;
  }

  // ── Spotify ───────────────────────────────────────────────────────────────
  if (platform === "Spotify" || /spotify/i.test(s)) {
    const m = s.match(/track\/([a-zA-Z0-9]+)/);
    if (m?.[1]) return `sp:${m[1]}`;
  }

  // ── Fallback — normalized URL as key ──────────────────────────────────────
  const norm = s
    .replace(/[?&](si|feature|pp|t|utm_[^&]*)=[^&]*/gi, "")
    .replace(/[?&]+$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
  return `url:${norm}`;
}

// ── Result cache ──────────────────────────────────────────────────────────────

/**
 * Look up a cached result by videoId.
 * Updates hitCount and lastUsed on every cache hit.
 *
 * @param {string} videoId
 * @returns {{ boomboxUrl:string, ytResult:object, hitCount:number, lastUsed:number } | null}
 */
export function getCachedResult(videoId) {
  const entry = _resultCache.get(videoId);
  if (!entry) { _misses++; return null; }

  if (Date.now() > entry.expire) {
    _resultCache.delete(videoId);
    _misses++;
    return null;
  }

  // Update hit stats in-place
  entry.hitCount++;
  entry.lastUsed = Date.now();
  _hits++;
  return entry;
}

/**
 * Store a result in the cache.
 *
 * @param {string} videoId
 * @param {{ boomboxUrl:string, ytResult:object }} data
 */
export function setCachedResult(videoId, { boomboxUrl, ytResult }) {
  const entry = {
    boomboxUrl,
    ytResult,
    hitCount:  0,
    createdAt: Date.now(),
    lastUsed:  Date.now(),
    expire:    Date.now() + RESULT_TTL_MS,
  };
  _resultCache.set(videoId, entry);

  // Evict oldest entry when over the size cap
  if (_resultCache.size > MAX_RESULT_CACHE) {
    _resultCache.delete(_resultCache.keys().next().value);
  }
}

// ── Metadata cache ────────────────────────────────────────────────────────────

/**
 * Look up cached metadata. Returns null if expired.
 *
 * @param {string} videoId
 * @returns {{ title:string|null, duration:number|null, thumbnail:string|null, uploader:string|null } | null}
 */
export function getCachedMeta(videoId) {
  const m = _metaCache.get(videoId);
  if (!m) return null;

  if (Date.now() - m.cachedAt > META_TTL_MS) {
    _metaCache.delete(videoId);
    return null;
  }
  return m;
}

/**
 * Store metadata in the metadata cache.
 *
 * @param {string} videoId
 * @param {{ title?:string|null, duration?:number|null, thumbnail?:string|null, uploader?:string|null }} meta
 */
export function setCachedMeta(videoId, meta) {
  _metaCache.set(videoId, { ...meta, cachedAt: Date.now() });
  if (_metaCache.size > MAX_META_CACHE) {
    _metaCache.delete(_metaCache.keys().next().value);
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/**
 * @returns {{ resultSize:number, metaSize:number, hits:number, misses:number, hitRate:string }}
 */
export function getCacheStats() {
  const total   = _hits + _misses;
  const hitRate = total > 0 ? `${((100 * _hits) / total).toFixed(1)}%` : "n/a";
  return {
    resultSize: _resultCache.size,
    metaSize:   _metaCache.size,
    hits:       _hits,
    misses:     _misses,
    hitRate,
  };
}

// ── Auto-clean ────────────────────────────────────────────────────────────────

function _autoClean() {
  const cutoff  = Date.now() - AUTO_CLEAN_DAYS * 24 * 60 * 60 * 1000;
  const now     = Date.now();
  let rEvicted  = 0;
  let mEvicted  = 0;

  for (const [id, entry] of _resultCache) {
    if (entry.lastUsed < cutoff || now > entry.expire) {
      _resultCache.delete(id);
      rEvicted++;
    }
  }
  for (const [id, entry] of _metaCache) {
    if (now - entry.cachedAt > META_TTL_MS * 4) { // keep meta longer, still clean eventually
      _metaCache.delete(id);
      mEvicted++;
    }
  }

  if (rEvicted || mEvicted) {
    logger.info(`[BoomBoxCache] Auto-clean | result evicted=${rEvicted} meta evicted=${mEvicted} | remaining: result=${_resultCache.size} meta=${_metaCache.size}`);
  }
}

// Run auto-clean every 6 hours. Unref so it doesn't keep the process alive.
const _cleanTimer = setInterval(_autoClean, AUTO_CLEAN_INTERVAL);
if (_cleanTimer.unref) _cleanTimer.unref();
