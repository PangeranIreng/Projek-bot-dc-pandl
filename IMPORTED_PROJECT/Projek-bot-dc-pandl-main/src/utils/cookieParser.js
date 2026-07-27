/**
 * cookieParser.js — Auto-detect and convert any cookie format to Netscape.
 *
 * Supported input formats:
 *   1. Netscape cookies.txt  — standard format exported by browser extensions
 *   2. Cookie Header         — multiline key=value, one pair per line
 *   3. Raw Browser Cookie    — one long line (or few lines) with KEY=VALUE; KEY=VALUE; ...
 *
 * The parser detects the format, extracts relevant YouTube/Google cookies,
 * deduplicates, and converts to Netscape format ready for yt-dlp.
 *
 * Security: cookie VALUES are never logged, returned to Discord, or stored in metadata.
 *
 * Exports:
 *   detectCookieFormat(content)  → 'netscape' | 'cookie-header' | 'raw-browser' | 'unknown'
 *   parseCookiesAuto(content)    → { ok, content, format, totalParsed, youtubeCookieCount }
 *                                   or { ok: false, reason, format }
 */

// ── YouTube / Google cookie names that yt-dlp needs ──────────────────────────
// Values are never compared — only names are.
const YOUTUBE_RELEVANT = new Set([
  // Google account auth (assigned to .google.com in real exports but placed on
  // .youtube.com here so yt-dlp sends them for youtube.com requests)
  "SID", "HSID", "SSID", "APISID", "SAPISID", "NID", "SIDCC",
  "__Secure-1PSID", "__Secure-3PSID",
  "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS",
  "__Secure-1PSIDCC", "__Secure-3PSIDCC",
  // YouTube-specific
  "LOGIN_INFO", "VISITOR_INFO1_LIVE", "YSC", "PREF", "GPS",
  "__Secure-YEC", "ACCOUNT_CHOOSER",
  // Consent / privacy
  "CONSENT", "SOCS",
]);

/** True when a cookie name requires the Secure attribute (Netscape column 4 = TRUE). */
function _isSecure(name) {
  return name.startsWith("__Secure-") || name.startsWith("__Host-");
}

/** Case-insensitive membership test for YOUTUBE_RELEVANT. */
function _isRelevant(name) {
  if (YOUTUBE_RELEVANT.has(name)) return true;
  const upper = name.toUpperCase();
  for (const n of YOUTUBE_RELEVANT) {
    if (n.toUpperCase() === upper) return true;
  }
  return false;
}

// ── Format detection ──────────────────────────────────────────────────────────

/**
 * Detect the cookie format from raw content.
 * @param {string} content
 * @returns {'netscape' | 'cookie-header' | 'raw-browser' | 'unknown'}
 */
export function detectCookieFormat(content) {
  const trimmed = (content ?? "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) return "unknown";

  // ── 1. Netscape: explicit header comment ─────────────────────────────────
  if (/^#\s*Netscape HTTP Cookie File/im.test(trimmed) ||
      /^#\s*HTTP Cookie File/im.test(trimmed)) {
    return "netscape";
  }

  // ── 2. Netscape: tab-delimited 7-column lines ────────────────────────────
  const dataLines = trimmed
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l && !l.trimStart().startsWith("#"));

  if (dataLines.length > 0) {
    const tabLines = dataLines.filter(l => l.split("\t").length === 7);
    // Majority of data lines are 7-column → Netscape
    if (tabLines.length > 0 && tabLines.length >= dataLines.length * 0.7) {
      return "netscape";
    }
  }

  // ── 3. Raw Browser Cookie ────────────────────────────────────────────────
  // Characteristics: one long line (or a few), semicolons as delimiters, KEY=VALUE pairs
  const hasSemicolons = trimmed.includes(";");
  const hasEquals     = trimmed.includes("=");

  if (hasSemicolons && hasEquals) {
    // If all non-empty lines together look like a semicolon-separated cookie string
    // OR if there is only one or two non-empty lines
    const nonEmpty = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (nonEmpty.length <= 3) {
      return "raw-browser";
    }
    // More lines but semicolons within lines → raw-browser (e.g., wrapped at terminal)
    if (dataLines.some(l => l.includes(";"))) {
      return "raw-browser";
    }
  }

  // ── 4. Cookie Header: each non-empty line is KEY=VALUE (no tabs, no semicolons) ─
  if (dataLines.length > 0) {
    const headerLike = dataLines.filter(
      l => /^[a-zA-Z_][a-zA-Z0-9_\-.]*\s*=/.test(l.trim()) &&
           !l.includes("\t") && !l.includes(";")
    );
    if (headerLike.length === dataLines.length) {
      return "cookie-header";
    }
  }

  // ── 5. Fallback: if we have = signs, try raw-browser ────────────────────
  if (hasEquals) return "raw-browser";

  return "unknown";
}

// ── Pair extraction ───────────────────────────────────────────────────────────

/**
 * Parse raw content (cookie-header or raw-browser) into [{name, value}] pairs.
 * Handles semicolons, newlines, and extra whitespace as delimiters.
 * @param {string} content
 * @returns {Array<{name: string, value: string}>}
 */
function _parsePairs(content) {
  const pairs = [];

  // Normalise line endings, then split on semicolons OR newlines
  const segments = content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/[;\n]+/);

  for (const seg of segments) {
    const s = seg.trim();
    if (!s || s.startsWith("#")) continue;

    const eqIdx = s.indexOf("=");
    if (eqIdx <= 0) continue;

    const name  = s.slice(0, eqIdx).trim();
    const value = s.slice(eqIdx + 1).trim();

    // Validate cookie name syntax
    if (!/^[a-zA-Z_][a-zA-Z0-9_\-.]*$/.test(name)) continue;

    pairs.push({ name, value });
  }

  return pairs;
}

// ── Netscape serialiser ───────────────────────────────────────────────────────

/**
 * Convert [{name, value}] pairs to Netscape cookies.txt string.
 * All cookies are placed on .youtube.com (domain yt-dlp uses for YouTube requests).
 * Expiry is 0 (session) since we don't know the real expiry from name=value format.
 * @param {Array<{name: string, value: string}>} pairs
 * @returns {string}
 */
function _toNetscape(pairs) {
  const header = "# Netscape HTTP Cookie File\n# Generated by BoomBox Cookie Auto-Parser\n\n";
  const lines = pairs.map(({ name, value }) => {
    const secure = _isSecure(name) ? "TRUE" : "FALSE";
    // domain · includeSubdomains · path · secure · expiry · name · value
    return `.youtube.com\tTRUE\t/\t${secure}\t0\t${name}\t${value}`;
  });
  return header + lines.join("\n") + "\n";
}

// ── Master function ───────────────────────────────────────────────────────────

/**
 * Auto-parse cookies from any supported format.
 *
 * On success returns:
 *   { ok: true, content: string (Netscape), format, totalParsed, youtubeCookieCount }
 *
 * On failure returns:
 *   { ok: false, reason: string (safe for Discord), format }
 *
 * Security: 'content' contains the Netscape file (with values) — ONLY for writing
 * to disk. Never send it to Discord or log it.
 *
 * @param {string} rawContent
 * @returns {{ ok: boolean, content?: string, format: string,
 *             totalParsed?: number, youtubeCookieCount?: number, reason?: string }}
 */
export function parseCookiesAuto(rawContent) {
  if (typeof rawContent !== "string" || !rawContent.trim()) {
    return { ok: false, reason: "Input kosong.", format: "unknown" };
  }

  const content = rawContent.replace(/^\uFEFF/, "").trim();
  const format  = detectCookieFormat(content);

  // ── Netscape: pass through directly, no conversion ────────────────────────
  if (format === "netscape") {
    return {
      ok: true,
      content: rawContent.replace(/^\uFEFF/, ""),
      format: "netscape",
      totalParsed: null,        // will be counted by validateCookiesContent
      youtubeCookieCount: null, // idem
    };
  }

  // ── Unknown: reject with helpful guidance ────────────────────────────────
  if (format === "unknown") {
    return {
      ok: false,
      format: "unknown",
      reason:
        "Format cookies tidak dapat dikenali.\n\n" +
        "**Format yang didukung:**\n" +
        "• `Netscape cookies.txt` — hasil ekspor ekstensi browser\n" +
        "• `Cookie Header` — satu pasang per baris (`NAMA=NILAI`)\n" +
        "• `Raw Browser Cookie` — satu baris panjang dipisahkan titik koma (`NAMA=NILAI; NAMA=NILAI`)",
    };
  }

  // ── Parse into name=value pairs ──────────────────────────────────────────
  const allPairs = _parsePairs(content);
  if (allPairs.length === 0) {
    return {
      ok: false,
      format,
      reason:
        "Tidak ada pasangan cookie yang berhasil diparsing. " +
        "Pastikan format `NAMA=NILAI` sudah benar.",
    };
  }

  // ── Filter to YouTube-relevant only ─────────────────────────────────────
  const relevant = allPairs.filter(p => _isRelevant(p.name));

  if (relevant.length === 0) {
    return {
      ok: false,
      format,
      reason:
        `Berhasil membaca **${allPairs.length}** cookie, namun tidak ada yang relevan untuk YouTube/Google.\n\n` +
        "Pastikan kamu menyalin cookies dari halaman **youtube.com** atau **google.com** saat sudah login.",
    };
  }

  // ── Deduplicate (last-write-wins) ────────────────────────────────────────
  const deduped = new Map();
  for (const { name, value } of relevant) {
    deduped.set(name, value);
  }
  const finalPairs = [...deduped.entries()].map(([name, value]) => ({ name, value }));

  // ── Convert to Netscape ──────────────────────────────────────────────────
  const netscapeContent = _toNetscape(finalPairs);

  return {
    ok: true,
    content: netscapeContent,
    format,
    totalParsed: allPairs.length,
    youtubeCookieCount: finalPairs.length,
  };
}

/** Human-readable format label for display in Discord messages (safe). */
export function formatLabel(format) {
  return {
    "netscape":      "Netscape cookies.txt",
    "cookie-header": "Cookie Header",
    "raw-browser":   "Raw Browser Cookie",
    "unknown":       "Format tidak dikenal",
  }[format] ?? format;
}
