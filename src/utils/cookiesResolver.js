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
let _validation = null;
let _lastUsedWriteTimer = null;

const MAX_COOKIE_BYTES = 2 * 1024 * 1024;

/**
 * Validate Netscape cookie content without ever returning the cookie values.
 * The returned summary is safe for status panels and logs.
 */
export function validateCookiesContent(content) {
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, reason: "File kosong atau tidak dapat dibaca." };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_COOKIE_BYTES) {
    return { ok: false, reason: "File terlalu besar (maksimum 2 MB)." };
  }

  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const dataLines = lines
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trimStart();
      return trimmed && (!trimmed.startsWith("#") || trimmed.startsWith("#HttpOnly_"));
    });

  if (dataLines.length === 0) {
    return { ok: false, reason: "File tidak mengandung data cookie (hanya komentar atau kosong)." };
  }

  let youtubeCookieCount = 0;
  let activeExpiryCount = 0;
  let maxExpiresAt = null;

  for (let index = 0; index < dataLines.length; index++) {
    const fields = dataLines[index].split("\t");
    if (fields.length !== 7) {
      return {
        ok: false,
        reason: `Baris cookie ke-${index + 1} tidak valid. Format Netscape harus memiliki tepat 7 kolom yang dipisahkan tab.`,
      };
    }

    const [rawDomain, includeSubdomains, cookiePath, secure, expiry, name, value] = fields;
    const domain = rawDomain.replace(/^#HttpOnly_/i, "").toLowerCase();
    if (!domain || !/^[a-z0-9.-]+$/.test(domain)) {
      return { ok: false, reason: `Domain pada baris ke-${index + 1} tidak valid.` };
    }
    if (!["TRUE", "FALSE"].includes(includeSubdomains.toUpperCase())) {
      return { ok: false, reason: `Kolom subdomain pada baris ke-${index + 1} harus TRUE atau FALSE.` };
    }
    if (!cookiePath.startsWith("/")) {
      return { ok: false, reason: `Path pada baris ke-${index + 1} harus diawali /.` };
    }
    if (!["TRUE", "FALSE"].includes(secure.toUpperCase())) {
      return { ok: false, reason: `Kolom secure pada baris ke-${index + 1} harus TRUE atau FALSE.` };
    }
    if (!/^\d+$/.test(expiry)) {
      return { ok: false, reason: `Expiry pada baris ke-${index + 1} harus berupa angka.` };
    }
    if (!name || value === undefined) {
      return { ok: false, reason: `Nama cookie pada baris ke-${index + 1} kosong.` };
    }

    if (domain === "youtube.com" || domain.endsWith(".youtube.com")) youtubeCookieCount++;
    const expiresAt = Number(expiry) * 1000;
    if (expiresAt === 0 || expiresAt > Date.now()) activeExpiryCount++;
    if (expiresAt > (maxExpiresAt ?? 0)) maxExpiresAt = expiresAt;
  }

  return {
    ok: true,
    youtubeCookieCount,
    hasYoutubeCookie: youtubeCookieCount > 0,
    activeExpiryCount,
    expiresAt: maxExpiresAt,
  };
}

function _inspectCookiesPath(cookiePath) {
  try {
    const stat = fs.statSync(cookiePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_COOKIE_BYTES) {
      return { ok: false, reason: "File cookies kosong, bukan file biasa, atau terlalu besar." };
    }
    return validateCookiesContent(fs.readFileSync(cookiePath, "utf8"));
  } catch (err) {
    return { ok: false, reason: `File cookies tidak dapat dibaca: ${err.message}` };
  }
}

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
  const validation = p ? _inspectCookiesPath(p) : null;
  _cookiesPath   = p && validation?.ok ? p : null;
  _cookiesSource = p && validation?.ok ? source : null;
  _validation    = validation;

  // Mutate COOKIES_ARGS in-place so all existing importers see the new value
  COOKIES_ARGS.length = 0;
  if (_cookiesPath) {
    COOKIES_ARGS.push("--cookies", _cookiesPath);
    logger.info(`[cookiesResolver] Cookies loaded (source: ${source})`);
  } else if (p) {
    logger.warn(`[cookiesResolver] Cookies ignored: ${validation?.reason ?? "format tidak valid"}`);
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
    const tmpPath = `${META_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, META_PATH);
  } catch (err) {
    try { fs.unlinkSync(`${META_PATH}.tmp`); } catch {}
    logger.warn(`[cookiesResolver] Could not save cookies meta: ${err.message}`);
  }
}

/** Update last-used metadata without writing on every download request. */
export function markCookiesUsed() {
  if (!_cookiesPath) return;
  const current = getCookiesMeta() ?? {};
  const next = { ...current, lastUsedAt: Date.now() };
  if (_lastUsedWriteTimer) return;
  _lastUsedWriteTimer = setTimeout(() => {
    _lastUsedWriteTimer = null;
    saveCookiesMeta(next);
  }, 30_000);
  _lastUsedWriteTimer.unref?.();
}

/** Persist the result of the explicit cookie test without exposing cookie data. */
export function recordCookiesTest({ ok, reason = null }) {
  const current = getCookiesMeta() ?? {};
  saveCookiesMeta({
    ...current,
    lastTestAt: Date.now(),
    lastTestOk: Boolean(ok),
    lastTestReason: ok ? null : String(reason ?? "Cookies tidak lolos test").slice(0, 240),
  });
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
  const meta = getCookiesMeta();
  const expiredByFile = Boolean(_validation?.ok && _validation.activeExpiryCount === 0);
  const expiredByTest = meta?.lastTestOk === false &&
    /expired|kedaluwarsa|tidak valid/i.test(meta.lastTestReason ?? "");
  const status = !_cookiesPath || sizeBytes === null
    ? "missing"
    : expiredByFile || expiredByTest
      ? "expired"
      : meta?.lastTestOk === true
        ? "valid"
        : "unverified";
  return {
    hasCookies: _cookiesPath !== null && sizeBytes !== null,
    path:       _cookiesPath,
    source:     _cookiesSource,
    sizeBytes,
    status,
    validation: _validation,
    meta,
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
