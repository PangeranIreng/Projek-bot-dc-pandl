/**
 * durationParser.js — Shared duration-string parsing for the Premium &
 * Limit Management slash commands (/addprem, /setlimit).
 *
 * Accepted formats:
 *   "7d"   → 7 days
 *   "12h"  → 12 hours
 *   "30m"  → 30 minutes
 *   "7"    → bare number, no unit -- caller treats this as "permanent"
 *            (see isBareNumber below); the numeric value itself is not
 *            used as a duration.
 */

const SUFFIX_RE = /^(\d+)\s*(d|h|m)$/i;
const BARE_NUMBER_RE = /^\d+$/;

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 };
const UNIT_LABEL = { d: "hari", h: "jam", m: "menit" };

/** True when the raw input is digits only (no d/h/m suffix) — "permanent" signal. */
export function isBareNumber(raw) {
  return BARE_NUMBER_RE.test(String(raw).trim());
}

/**
 * Parse a "<n>d" | "<n>h" | "<n>m" duration string.
 * @param {string} raw
 * @returns {{ ms: number, label: string } | null} null if the string doesn't match the suffix format.
 */
export function parseDurationSuffix(raw) {
  const m = SUFFIX_RE.exec(String(raw).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (!n || n <= 0) return null;
  return { ms: n * UNIT_MS[unit], label: `${n} ${UNIT_LABEL[unit]}` };
}

/**
 * Parse an /addprem-style duration argument: either a bare number
 * (permanent) or a "<n>d|h|m" suffix (temporary).
 *
 * @param {string} raw
 * @returns {{ permanent: true } | { permanent: false, ms: number, label: string } | null} null if invalid input.
 */
export function parsePremiumDuration(raw) {
  if (isBareNumber(raw)) return { permanent: true };
  const parsed = parseDurationSuffix(raw);
  if (!parsed) return null;
  return { permanent: false, ...parsed };
}
