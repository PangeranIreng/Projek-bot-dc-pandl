/**
 * utils/fileUtils.js — File/buffer utility helpers shared across the
 * scanner pipeline.
 *
 * Exports:
 *   formatBytes(n)          → human-readable size string ("1.23 MB")
 *   truncate(str, max)      → cut a string to max chars, appending "…"
 *   getExtension(filename)  → lowercase extension including leading dot
 *   calculateEntropy(buf)   → Shannon entropy on [0, 8] scale
 *   printableRatio(buf)     → fraction [0, 1] of printable ASCII bytes
 */

import path from "node:path";

// ── Format ─────────────────────────────────────────────────────────────────

const UNITS = ["B", "KB", "MB", "GB"];

/**
 * @param {number} bytes
 * @returns {string}  e.g. "1.23 MB"
 */
export function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(2)} ${UNITS[u]}`;
}

/**
 * Truncate a string to at most `max` characters, appending "…" if cut.
 * @param {string|null|undefined} str
 * @param {number} max
 * @returns {string}
 */
export function truncate(str, max = 100) {
  if (str == null) return "";
  const s = String(str);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ── File type ──────────────────────────────────────────────────────────────

/**
 * Return the lowercase extension of a filename (including the leading dot),
 * or "" if there is none.
 * @param {string} filename
 * @returns {string}  e.g. ".lua"
 */
export function getExtension(filename) {
  if (!filename) return "";
  return path.extname(filename).toLowerCase();
}

// ── Byte-level analysis ───────────────────────────────────────────────────

/**
 * Shannon entropy of the byte distribution in a buffer, on [0, 8].
 * Pure binary random data ≈ 8; plain ASCII text ≈ 4–5; constant bytes = 0.
 * @param {Buffer} buffer
 * @returns {number}
 */
export function calculateEntropy(buffer) {
  if (!buffer || buffer.length === 0) return 0;

  // Count frequency of each byte value (0-255).
  const freq = new Uint32Array(256);
  for (let i = 0; i < buffer.length; i++) freq[buffer[i]]++;

  const n = buffer.length;
  let entropy = 0;
  for (let b = 0; b < 256; b++) {
    if (freq[b] === 0) continue;
    const p = freq[b] / n;
    entropy -= p * Math.log2(p);
  }

  return Math.max(0, Math.min(8, entropy));
}

/**
 * Fraction of bytes in `buffer` that are printable ASCII (0x09-0x0d or
 * 0x20-0x7e). Used to determine whether a buffer is text-like.
 * @param {Buffer} buffer
 * @returns {number}  value on [0, 1]
 */
export function printableRatio(buffer) {
  if (!buffer || buffer.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if ((b >= 0x20 && b <= 0x7e) || (b >= 0x09 && b <= 0x0d)) count++;
  }
  return count / buffer.length;
}
