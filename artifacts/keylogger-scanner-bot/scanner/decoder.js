// Low-level decode primitives. Each function tries exactly one well-understood
// encoding and reports honestly whether it produced plausible output --
// nothing here is allowed to claim success without validating the result
// (checked via printable-byte ratio). These are building blocks used by
// deobfuscator.js's recovery pipeline; they never throw.

import zlib from "node:zlib";
import { printableRatio } from "../utils/fileUtils.js";

export const MIN_PRINTABLE_RATIO_FOR_SUCCESS = 0.85;
const MAX_CANDIDATES = 8;

function isValidResult(buf) {
  return buf && buf.length > 0 && printableRatio(buf) >= MIN_PRINTABLE_RATIO_FOR_SUCCESS;
}

/**
 * Decode base64-looking runs of text. Validates by re-encoding and checking
 * printable ratio of the result -- a real base64 blob round-trips cleanly.
 */
export function decodeBase64Candidates(text) {
  const candidates = Array.from(
    new Set((text.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []).slice(0, MAX_CANDIDATES)),
  );
  const results = [];
  for (const candidate of candidates) {
    try {
      const buf = Buffer.from(candidate, "base64");
      if (buf.length === 0) continue;
      const reencoded = buf.toString("base64").replace(/=+$/, "");
      const original = candidate.replace(/=+$/, "");
      if (reencoded !== original) continue;
      if (isValidResult(buf)) {
        results.push({ input: candidate, output: buf.toString("utf8"), buffer: buf });
      }
    } catch {
      // Not valid base64 -- skip silently, this is expected for most text.
    }
  }
  return { attempted: true, method: "Base64 decode", results };
}

/**
 * Decode runs of \xNN hex-escape sequences into raw bytes.
 */
export function decodeHexEscapeCandidates(text) {
  const runs = text.match(/(?:\\x[0-9a-fA-F]{2}){8,}/g) || [];
  const results = [];
  for (const run of runs.slice(0, MAX_CANDIDATES)) {
    const bytePairs = run.match(/\\x([0-9a-fA-F]{2})/g) || [];
    try {
      const buf = Buffer.from(bytePairs.map((b) => b.slice(2)).join(""), "hex");
      if (isValidResult(buf)) {
        results.push({ input: run, output: buf.toString("utf8"), buffer: buf });
      }
    } catch {
      // malformed hex run
    }
  }
  return { attempted: true, method: "Hex escape unescape", results };
}

/**
 * Decode runs of \u00NN unicode-escape sequences into raw bytes.
 */
export function decodeUnicodeEscapeCandidates(text) {
  const runs = text.match(/(?:\\u00[0-9a-fA-F]{2}){8,}/g) || [];
  const results = [];
  for (const run of runs.slice(0, MAX_CANDIDATES)) {
    const bytePairs = run.match(/\\u00([0-9a-fA-F]{2})/g) || [];
    try {
      const buf = Buffer.from(bytePairs.map((b) => b.slice(4)).join(""), "hex");
      if (isValidResult(buf)) {
        results.push({ input: run, output: buf.toString("utf8"), buffer: buf });
      }
    } catch {
      // malformed unicode-escape run
    }
  }
  return { attempted: true, method: "Unicode escape unescape", results };
}

/**
 * Decode Lua's common `string.char(65, 66, 67, ...)` obfuscation idiom into
 * the literal string it produces. This is a genuine, verifiable
 * transformation (not a guess) -- we only accept a match when every
 * argument is a valid byte value.
 */
export function decodeStringCharCalls(text) {
  const pattern = /string\.char\s*\(\s*([\d\s,]+?)\s*\)/g;
  const results = [];
  let match;
  let count = 0;
  while ((match = pattern.exec(text)) !== null && count < MAX_CANDIDATES) {
    const nums = match[1]
      .split(",")
      .map((n) => Number.parseInt(n.trim(), 10));
    if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) continue;
    const decoded = Buffer.from(nums);
    results.push({ input: match[0], output: decoded.toString("utf8"), buffer: decoded });
    count += 1;
  }
  return { attempted: true, method: "Decode string.char()", results };
}

/**
 * Single-byte XOR key brute force over the raw buffer. Only meaningful for
 * binary-looking content; guarded against huge buffers for performance.
 * Always reports as "attempted" when called, even if it finds nothing.
 */
export function decodeXorBruteForce(buffer) {
  const method = "Single-byte XOR brute force";
  if (!buffer || buffer.length < 8 || buffer.length > 3_000_000) {
    return { attempted: true, method, results: [], skipped: "Ukuran buffer di luar batas yang aman untuk brute force." };
  }

  // If the buffer is already mostly printable text, it isn't XOR-packed --
  // brute forcing it anyway would just risk a spurious "successful" decode
  // (short printable text XORed with a low key can coincidentally still
  // look printable). Record the attempt honestly without fabricating a hit.
  const originalRatio = printableRatio(buffer);
  if (originalRatio >= 0.85) {
    return {
      attempted: true,
      method,
      results: [],
      skipped: "Tidak diperlukan -- file sudah berupa teks yang dapat dibaca langsung.",
    };
  }

  let best = null;
  for (let key = 1; key < 256; key += 1) {
    const decoded = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length; i += 1) {
      decoded[i] = buffer[i] ^ key;
    }
    const ratio = printableRatio(decoded);
    // Require a real, non-trivial improvement over the original -- and a
    // strong absolute printable ratio -- so we don't call noise a "decode".
    if (
      ratio >= MIN_PRINTABLE_RATIO_FOR_SUCCESS &&
      ratio > originalRatio + 0.15 &&
      (!best || ratio > best.ratio)
    ) {
      best = { key, ratio, decoded };
    }
  }

  if (!best) return { attempted: true, method, results: [] };
  return {
    attempted: true,
    method,
    results: [
      {
        input: `key=0x${best.key.toString(16)}`,
        output: best.decoded.toString("utf8"),
        buffer: best.decoded,
      },
    ],
  };
}

/**
 * Decode Lua/Python-style `\NNN` decimal-escape runs (e.g. `\104\101\108`)
 * into the raw bytes they represent.
 */
export function decodeDecimalEscapeCandidates(text) {
  const runs = text.match(/(?:\\\d{1,3}){8,}/g) || [];
  const results = [];
  for (const run of runs.slice(0, MAX_CANDIDATES)) {
    const groups = run.match(/\\(\d{1,3})/g) || [];
    try {
      const bytes = groups.map((g) => Number.parseInt(g.slice(1), 10));
      if (bytes.some((b) => Number.isNaN(b) || b > 255)) continue;
      const buf = Buffer.from(bytes);
      if (isValidResult(buf)) {
        results.push({ input: run, output: buf.toString("utf8"), buffer: buf });
      }
    } catch {
      // malformed decimal-escape run
    }
  }
  return { attempted: true, method: "Decimal escape unescape", results };
}

/**
 * Decode Python-style `\NNN` octal-escape runs (3-digit, base-8) into the
 * raw bytes they represent.
 */
export function decodeOctalEscapeCandidates(text) {
  const runs = text.match(/(?:\\[0-3][0-7]{2}){8,}/g) || [];
  const results = [];
  for (const run of runs.slice(0, MAX_CANDIDATES)) {
    const groups = run.match(/\\([0-3][0-7]{2})/g) || [];
    try {
      const bytes = groups.map((g) => Number.parseInt(g.slice(1), 8));
      if (bytes.some((b) => Number.isNaN(b) || b > 255)) continue;
      const buf = Buffer.from(bytes);
      if (isValidResult(buf)) {
        results.push({ input: run, output: buf.toString("utf8"), buffer: buf });
      }
    } catch {
      // malformed octal-escape run
    }
  }
  return { attempted: true, method: "Octal escape unescape", results };
}

/**
 * Attempt gzip decompression of the raw buffer. Only meaningful on the
 * whole-file buffer (magic bytes 1F 8B), so this never scans substrings --
 * it either recognizes the file as gzip or reports nothing.
 */
export function decodeGzipBuffer(buffer) {
  const method = "Gzip decompress";
  if (!buffer || buffer.length < 2 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
    return { attempted: true, method, results: [] };
  }
  try {
    const out = zlib.gunzipSync(buffer);
    if (isValidResult(out)) {
      return { attempted: true, method, results: [{ input: "__whole_buffer__", output: out.toString("utf8"), buffer: out, whole: true }] };
    }
    return { attempted: true, method, results: [] };
  } catch {
    return { attempted: true, method, results: [] };
  }
}

/**
 * Attempt zlib inflate of the raw buffer (magic byte 0x78). Same
 * whole-buffer semantics as gzip above.
 */
export function decodeZlibBuffer(buffer) {
  const method = "Zlib inflate";
  if (!buffer || buffer.length < 2 || buffer[0] !== 0x78) {
    return { attempted: true, method, results: [] };
  }
  try {
    const out = zlib.inflateSync(buffer);
    if (isValidResult(out)) {
      return { attempted: true, method, results: [{ input: "__whole_buffer__", output: out.toString("utf8"), buffer: out, whole: true }] };
    }
    return { attempted: true, method, results: [] };
  } catch {
    return { attempted: true, method, results: [] };
  }
}
