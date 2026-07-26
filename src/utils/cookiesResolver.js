/**
 * cookiesResolver.js — YouTube cookies support for yt-dlp anti-bot bypass.
 *
 * Resolution order (highest priority first):
 *   1. MANAGED_COOKIES_PATH (cookies.txt in project root, uploaded via Resource Manager)
 *   2. YOUTUBE_COOKIES env var — absolute or project-root-relative path
 *   3. cookies.txt in project root — auto-detected, no config needed
 *
 * Hot-reload: call reloadCookies() after uploading or deleting a cookies file.
 * COOKIES_ARGS is mutated in-place so all callers see the updated value immediately
 * without needing to re-import the module.
 *
 * Exports:
 *   COOKIES_ARGS          string[]    ["--cookies", "/path"] or [] — MUTATED IN PLACE on reload
 *   hasCookies            boolean     true when a valid cookies file was found (snapshot at last reload)
 *   COOKIES_PATH          string|null resolved path at last reload
 *   MANAGED_COOKIES_PATH  string      fixed path for Resource Manager uploads
 *   reloadCookies()       void        re-scan and update COOKIES_ARGS in-place
 *   getCookiesStatus()    object      full status object for display panels
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..");

/** Fixed path where Resource Manager uploads cookies files. */
export const MANAGED_COOKIES_PATH = path.join(PROJECT_ROOT, "cookies.txt");

/** Fixed path for cookie metadata (upload time, source). */
const META_PATH = path.join(PROJECT_ROOT, "data", "cookies-meta.json");

// ── Internal mutable state ────────────────────────────────────────────────────

let _cookiesPath = null;
let _cookiesSource = null; // "managed" | "env" | "root" | null

function _resolveCookiesPath() {
  // ── 1. Managed cookies (uploaded via Resource Manager = project root cookies.txt)
  if (fs.existsSync(MANAGED_COOKIES_PATH)) {
    return { path: MANAGED_COOKIES_PATH, source: "managed" };
  }

  // ── 2. Explicit YOUTUBE_COOKIES env var ──────────────────────────────────
  const envVal = process.env.YOUTUBE_COOKIES?.trim();
  if (envVal) {
    const resolved = path.isAbsolute(envVal) ? envVal : path.join(PROJECT_ROOT, envVal);
    if (fs.existsSync(resolved)) {
      return { path: resolved, source: "env" };
    }
    logger.warn(`[cookiesResolver] YOUTUBE_COOKIES is set but file not found: ${resolved} — continuing without cookies`);
  }

  return { path: null, source: null };
}

/** Reload cookie state and mutate COOKIES_ARGS in-place. */
export function reloadCookies() {
  const { path: p, source } = _resolveCookiesPath();
  _cookiesPath   = p;
  _cookiesSource = source;

  // Mutate COOKIES_ARGS in-place so all existing importers see the new value
  COOKIES_ARGS.length = 0;
  if (p) {
    COOKIES_ARGS.push("--cookies", p);
    logger.info(`[cookiesResolver] Cookies reloaded: ${p} (source: ${source})`);
  }

  // Re-export snapshot values (these are module-level, used at call time by callers)
  // Note: hasCookies and COOKIES_PATH are reassigned below; callers that spread
  // COOKIES_ARGS inside functions will see the updated array content.
}

/** Load cookie upload metadata from disk (returns null if not present). */
export function getCookiesMeta() {
  try {
    if (fs.existsSync(META_PATH)) {
      return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    }
  } catch {/* ignore */}
  return null;
}

/** Persist cookie upload metadata. */
export function saveCookiesMeta(meta) {
  try {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), "utf8");
  } catch (err) {
    logger.warn(`[cookiesResolver] Could not save cookies meta: ${err.message}`);
  }
}

/** Delete cookie metadata. */
export function clearCookiesMeta() {
  try { if (fs.existsSync(META_PATH)) fs.unlinkSync(META_PATH); } catch {/* ignore */}
}

/**
 * Full status object for display panels.
 * @returns {{ hasCookies: boolean, path: string|null, source: string|null,
 *             sizeBytes: number|null, meta: object|null }}
 */
export function getCookiesStatus() {
  let sizeBytes = null;
  if (_cookiesPath) {
    try { sizeBytes = fs.statSync(_cookiesPath).size; } catch {/* file may have been deleted */}
  }
  return {
    hasCookies: _cookiesPath !== null && sizeBytes !== null,
    path:       _cookiesPath,
    source:     _cookiesSource,
    sizeBytes,
    meta:       getCookiesMeta(),
  };
}

// ── Exported live-binding constants ───────────────────────────────────────────

/**
 * MUTABLE array — callers that spread this inside functions see updates immediately.
 * Never reassign this export; mutate its contents via reloadCookies().
 */
export const COOKIES_ARGS = [];

// Initialize at module load
reloadCookies();

/** Snapshot of hasCookies at last reload — use getCookiesStatus() for live state. */
export const hasCookies   = _cookiesPath !== null;

/** Snapshot of resolved path at last reload — use getCookiesStatus() for live state. */
export const COOKIES_PATH = _cookiesPath;
