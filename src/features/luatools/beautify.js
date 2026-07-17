/**
 * src/features/luatools/beautify.js — Local Lua code beautifier.
 *
 * Normalizes indentation and collapses excessive blank lines.
 * Uses luaparse to validate syntax first; rejects invalid Lua with a clear error.
 */

import luaparse from "luaparse";

/**
 * Beautify a Lua source string.
 * @param {string} source  Raw Lua code
 * @returns {{ ok: true, result: string } | { ok: false, error: string }}
 */
export function beautifyLua(source) {
  // ── 1. Validate syntax ───────────────────────────────────────────────────
  try {
    luaparse.parse(source, { luaVersion: "5.3" });
  } catch (parseErr) {
    return {
      ok: false,
      error: `Syntax error: ${parseErr.message}`,
    };
  }

  // ── 2. Apply indentation ─────────────────────────────────────────────────
  const INDENT    = "  "; // 2 spaces
  const rawLines  = source.replace(/\r\n?/g, "\n").split("\n");
  const out       = [];
  let   depth     = 0;
  let   prevBlank = false;

  for (const raw of rawLines) {
    const line = raw.trim();

    // Collapse consecutive blank lines to one
    if (line === "") {
      if (!prevBlank) out.push("");
      prevBlank = true;
      continue;
    }
    prevBlank = false;

    // Dedent BEFORE printing: end / until / else / elseif
    if (/^(end\b|until\b|else\b|elseif\b)/.test(line)) {
      depth = Math.max(0, depth - 1);
    }

    out.push(INDENT.repeat(depth) + line);

    // Count net block openers on this line (skip comment-only lines)
    if (!line.startsWith("--")) {
      const stripped = _stripStrings(line).replace(/--.*$/, "");
      const opens    = _count(stripped, /\b(do|then|repeat)\b/g)
                     + _count(stripped, /\bfunction\b/g);
      const closes   = _count(stripped, /\bend\b|\buntil\b/g);
      // "else" was already dedented above, re-indent after
      const elseOpen = /^else\b/.test(line) ? 1 : 0;

      const net = opens - closes + elseOpen;
      depth = Math.max(0, depth + net);
    }
  }

  // Remove trailing blank lines, add final newline
  const result = out.join("\n").trimEnd() + "\n";
  return { ok: true, result };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _count(str, re) {
  return (str.match(re) ?? []).length;
}

/** Replace string literals with empty strings to avoid keyword false-positives. */
function _stripStrings(line) {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g,  '""')
    .replace(/'(?:[^'\\]|\\.)*'/g,  "''")
    .replace(/\[=*\[.*?\]=*\]/g,    '""');
}
