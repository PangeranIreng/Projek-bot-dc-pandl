/**
 * kyzzClient.js — Core HTTP client for Kyzz API (api.kyzzz.eu.cc).
 *
 * Features:
 *   • API key via KYZZ_API_KEY env var — never hardcoded
 *   • Auto retry with exponential back-off (up to MAX_RETRIES)
 *   • Per-provider circuit breaker (integrates with providerHealth.js)
 *   • Per-request timeout (default 15s)
 *   • Rate-limit detection (429) → short backoff, no OFFLINE
 *   • Clean error messages — never expose API key or internals to users
 *
 * Usage:
 *   import { kyzzGet, KYZZ_BASE } from "./kyzzClient.js";
 *   const json = await kyzzGet("/api/download/aio", { url: "https://..." });
 */

import https from "node:https";
import http  from "node:http";
import { logger } from "../utils/logger.js";
import {
  shouldSkip,
  recordSuccess,
  recordFailure,
  classifyError,
  ERROR_CATEGORY,
} from "./providerHealth.js";
import { recordProviderResult } from "./providerMonitor.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const KYZZ_BASE            = "https://api.kyzzz.eu.cc";
const PROVIDER_KEY                = "kyzz-api";
const DEFAULT_TIMEOUT_MS          = 15_000;
const MAX_RETRIES                 = 3;
const RETRY_BASE_DELAY_MS         = 1_500;
const RATE_LIMIT_BACKOFF_MS       = 30_000; // 30s on 429

/** @type {Map<string, number>} endpoint → rateLimitUntil timestamp */
const _endpointRateLimit = new Map();

// ── API Key resolution ────────────────────────────────────────────────────────

/**
 * Read API key from environment at call-time (not at module load)
 * so restarts / secret updates are picked up without re-deploy.
 * Returns empty string when not set — callers decide whether to include it.
 * @returns {string}
 */
function _getApiKey() {
  return process.env.KYZZ_API_KEY?.trim() ?? "";
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Perform a GET request, follow up to 5 redirects, return parsed JSON.
 * @param {string}          url
 * @param {number}          [timeoutMs=DEFAULT_TIMEOUT_MS]
 * @param {AbortSignal}     [signal]
 * @returns {Promise<any>}
 */
function _httpGetJson(url, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(Object.assign(new Error("Kyzz request aborted"), { name: "AbortError" }));
    }

    let hops    = 0;
    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const onAbort = () => settle(reject, Object.assign(new Error("Kyzz request aborted (signal)"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });

    const step = (currentUrl) => {
      hops++;
      if (hops > 5) return settle(reject, new Error("Kyzz: too many redirects"));

      let parsed;
      try { parsed = new URL(currentUrl); }
      catch { return settle(reject, new Error(`Kyzz: invalid URL: ${currentUrl}`)); }

      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.get(
        {
          hostname: parsed.hostname,
          path:     parsed.pathname + parsed.search,
          headers:  {
            "User-Agent": "KyzzBotClient/1.0",
            "Accept":     "application/json",
          },
          timeout: timeoutMs,
        },
        (res) => {
          // Follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            try {
              step(new URL(res.headers.location, currentUrl).toString());
            } catch {
              settle(reject, new Error(`Kyzz: invalid redirect location: ${res.headers.location}`));
            }
            return;
          }

          let body = "";
          res.setEncoding("utf8");
          res.on("data",  (c) => { body += c; });
          res.on("error", (e) => settle(reject, new Error(`Kyzz response error: ${e.message}`)));
          res.on("end",   () => {
            if (res.statusCode === 429) {
              return settle(reject, Object.assign(new Error("Kyzz API: rate limited (429)"), { httpStatus: 429 }));
            }
            if (res.statusCode >= 400) {
              return settle(reject, Object.assign(
                new Error(`Kyzz API HTTP ${res.statusCode}`),
                { httpStatus: res.statusCode }
              ));
            }
            try {
              settle(resolve, JSON.parse(body));
            } catch {
              settle(reject, new Error(`Kyzz API returned non-JSON (status ${res.statusCode}): ${body.slice(0, 150)}`));
            }
          });
        },
      );

      req.on("timeout", () => {
        req.destroy();
        settle(reject, new Error(`Kyzz API timed out (>${timeoutMs / 1000}s)`));
      });
      req.on("error", (e) => settle(reject, new Error(`Kyzz network error: ${e.message}`)));
      req.on("close", () => signal?.removeEventListener("abort", onAbort));
    };

    step(url);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Make a GET request to a Kyzz API endpoint with automatic retry,
 * circuit breaker, and API key injection.
 *
 * @param {string}  endpoint  e.g. "/api/download/aio"
 * @param {Record<string,string>} [params]  Query parameters (excluding apikey)
 * @param {{
 *   timeoutMs?:  number,
 *   signal?:     AbortSignal,
 *   skipAuth?:   boolean,   // Don't include apikey (for public endpoints)
 * }} [opts]
 * @returns {Promise<any>}   Parsed JSON response
 */
export async function kyzzGet(endpoint, params = {}, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, skipAuth = false } = opts;

  // ── Circuit breaker ───────────────────────────────────────────────────────
  if (shouldSkip(PROVIDER_KEY)) {
    const err = new Error("Kyzz API tidak tersedia saat ini (circuit breaker terbuka — auto-retry segera)");
    err.code = "CIRCUIT_OPEN";
    throw err;
  }

  // ── Endpoint rate-limit check ─────────────────────────────────────────────
  const rlExp = _endpointRateLimit.get(endpoint);
  if (rlExp && Date.now() < rlExp) {
    const waitSec = Math.ceil((rlExp - Date.now()) / 1000);
    throw new Error(`Kyzz API: endpoint ${endpoint} rate-limited, coba lagi dalam ${waitSec}s`);
  }

  // ── Build URL ─────────────────────────────────────────────────────────────
  const apiKey = _getApiKey();
  const query  = new URLSearchParams(params);
  if (apiKey && !skipAuth) query.set("apikey", apiKey);

  const url = `${KYZZ_BASE}${endpoint}?${query.toString()}`;
  // Log without API key for security
  const safeUrl = `${KYZZ_BASE}${endpoint}?${new URLSearchParams(params).toString()}`;
  logger.debug(`[KyzzClient] GET ${safeUrl}`);

  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      const e = Object.assign(new Error("Kyzz request aborted"), { name: "AbortError" });
      throw e;
    }

    try {
      const t0  = Date.now();
      const res = await _httpGetJson(url, timeoutMs, signal);
      const ms  = Date.now() - t0;

      recordSuccess(PROVIDER_KEY);
      recordProviderResult(PROVIDER_KEY, true, ms);
      logger.debug(`[KyzzClient] ✓ ${endpoint} (${ms}ms, attempt ${attempt})`);
      return res;

    } catch (err) {
      lastErr = err;

      if (err.name === "AbortError") throw err;

      const ms  = Date.now();
      const cat = classifyError(err.message);
      recordFailure(PROVIDER_KEY, { reason: err.message, category: cat });
      recordProviderResult(PROVIDER_KEY, false, 0);

      // 429 → set endpoint-specific backoff, throw immediately (no retry)
      if (err.httpStatus === 429) {
        _endpointRateLimit.set(endpoint, Date.now() + RATE_LIMIT_BACKOFF_MS);
        logger.warn(`[KyzzClient] Rate limited on ${endpoint} — backoff ${RATE_LIMIT_BACKOFF_MS / 1000}s`);
        throw new Error(`Kyzz API rate limited. Coba lagi dalam ${RATE_LIMIT_BACKOFF_MS / 1000}s`);
      }

      // 4xx (not 429) → no retry
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        logger.warn(`[KyzzClient] 4xx on ${endpoint}: ${err.message} — no retry`);
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_DELAY_MS * attempt;
        logger.warn(`[KyzzClient] ⚠ Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message} — retry in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
      } else {
        logger.error(`[KyzzClient] ❌ All ${MAX_RETRIES} attempts failed for ${endpoint}: ${err.message}`);
      }
    }
  }

  throw lastErr;
}

/**
 * Health check — verify Kyzz API is reachable.
 * Returns true if reachable, false otherwise.
 * @returns {Promise<boolean>}
 */
export async function kyzzHealthCheck() {
  try {
    // Use a lightweight endpoint for the health check
    await _httpGetJson(`${KYZZ_BASE}/`, 5_000);
    recordSuccess(PROVIDER_KEY);
    return true;
  } catch {
    recordFailure(PROVIDER_KEY, { reason: "Health check failed" });
    return false;
  }
}

/**
 * Returns current Kyzz provider health status.
 */
export function getKyzzStatus() {
  const { getStatus } = await import("./providerHealth.js").catch(() => ({ getStatus: () => null }));
  return null; // use getAllStatuses() from providerHealth directly
}

export { PROVIDER_KEY as KYZZ_PROVIDER_KEY };
