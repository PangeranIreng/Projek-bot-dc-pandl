// Recovery engine. Treats obfuscation/encoding as a stack of layers and
// peels them one at a time -- each layer tries every supported decode
// method (string.char, base64, hex-escape, unicode-escape, single-byte XOR)
// against the current working text, honestly reporting whether that layer
// opened or not. Recovery stops the first time a layer makes no further
// progress (there is nothing left it can honestly claim to have decoded).
// Nothing here is allowed to report success without validating the output
// (printable-ratio check inside decoder.js).

import * as decoder from "./decoder.js";
import { scanIndicators } from "./heuristic.js";
import { printableRatio } from "../utils/fileUtils.js";

const MAX_LAYERS = 5;

/**
 * Remove a handful of *simple*, unambiguous junk-code patterns that
 * obfuscators commonly insert as noise. This is intentionally conservative
 * -- it never rewrites control flow, only strips clearly inert statements.
 */
export function stripSimpleJunk(text) {
  if (!text) return { text, changed: false };
  let result = text;
  result = result.replace(/;{2,}/g, ";");
  result = result.replace(/\bdo\s*end\b/g, "");
  result = result.replace(/\bif\s+false\s+then\b[^\n]*?\bend\b/g, "");
  result = result.replace(/\blocal\s+_0x[0-9a-fA-F]+\s*=\s*nil\s*;?/g, "");
  return { text: result, changed: result !== text };
}

/**
 * Fold a handful of constant expressions obfuscators love to generate:
 * literal string concatenation ("a" .. "b" -> "ab") and simple numeric
 * literal arithmetic in parentheses. Purely syntactic and reversible --
 * never guesses at runtime values.
 */
export function simplifyExpressions(text) {
  if (!text) return { text, changed: false };
  let result = text;

  const concatPattern = /(["'])((?:(?!\1).)*)\1(?:\s*\.\.\s*(["'])((?:(?!\3).)*)\3)+/g;
  result = result.replace(concatPattern, (whole) => {
    const parts = whole.match(/(["'])((?:(?!\1).)*)\1/g) || [];
    const joined = parts.map((p) => p.slice(1, -1)).join("");
    return `"${joined.replace(/"/g, '\\"')}"`;
  });

  result = result.replace(/\((\d+)\s*([+\-*])\s*(\d+)\)/g, (whole, a, op, b) => {
    const x = Number(a);
    const y = Number(b);
    const value = op === "+" ? x + y : op === "-" ? x - y : x * y;
    return Number.isFinite(value) ? String(value) : whole;
  });

  return { text: result, changed: result !== text };
}

/**
 * Inline `local NAME = "literal"` string declarations at their usage sites
 * *only* where that identifier sits directly next to a `..` concatenation
 * operator. This targets the specific "fragmented secret" pattern (a
 * webhook/token/URL split into pieces assigned to short-lived locals, then
 * joined at runtime) without doing general-purpose data-flow analysis or
 * touching any other use of the variable. Purely textual substitution for
 * re-scanning purposes -- no code is ever executed.
 */
export function inlineLocalStringLiterals(text) {
  if (!text) return { text, changed: false };

  const literalMap = new Map();
  const declPattern = /\blocal\s+([A-Za-z_]\w*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(?:;|\n|$)/g;
  let decl;
  while ((decl = declPattern.exec(text)) !== null) {
    const [, name, rawLiteral] = decl;
    // Only remember short/medium literals -- long ones are unlikely to be
    // secret fragments and inlining them everywhere would just bloat text.
    if (rawLiteral.length <= 200) literalMap.set(name, rawLiteral.slice(1, -1));
  }
  if (literalMap.size === 0) return { text, changed: false };

  let result = text;
  let changed = false;
  for (const [name, literal] of literalMap) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = `"${literal.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const usagePattern = new RegExp(`(\\.\\.\\s*)\\b${escaped}\\b|\\b${escaped}\\b(\\s*\\.\\.)`, "g");
    const before = result;
    result = result.replace(usagePattern, (whole, pre, post) => (pre ? `${pre}${quoted}` : `${quoted}${post}`));
    if (result !== before) changed = true;
  }
  return { text: result, changed };
}

// URLs (including webhooks) naturally contain long runs of the same
// alphanumeric-plus-slash charset base64 uses, which would otherwise look
// like an encoded blob by coincidence. Strip them before testing for an
// encoding signal so a plain file that just happens to contain a link
// doesn't get flagged as "protected".
function stripUrls(text) {
  return text.replace(/https?:\/\/[^\s'"<>)\]]+/gi, " ");
}

// Cheap, honest check for "does this content show any sign of being
// encoded/wrapped at all" -- used to decide whether layer-by-layer recovery
// is even applicable, so a plain text file doesn't get a fabricated
// "Layer 1 gagal dibuka" when there was never anything to open.
function hasEncodingSignal(text, buffer) {
  if (!text) return printableRatio(buffer) < 0.85;
  const scrubbed = stripUrls(text);
  const encodedPattern =
    /(?:[A-Za-z0-9+/]{40,}={0,2})|(?:\\x[0-9a-fA-F]{2}){8,}|(?:\\u00[0-9a-fA-F]{2}){8,}|(?:\\\d{1,3}){8,}|(?:\\[0-3][0-7]{2}){8,}|string\.char\s*\(/;
  const isGzipOrZlib =
    (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) ||
    (buffer.length >= 2 && buffer[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buffer[1]));
  return encodedPattern.test(scrubbed) || isGzipOrZlib || printableRatio(buffer) < 0.85;
}

/**
 * Run the layered recovery pipeline against a file's buffer/text.
 * @param {Buffer} buffer raw file bytes
 * @param {string} text best-effort utf8 decode of the buffer
 */
export function runRecoveryPipeline(buffer, text) {
  const attempted = [];
  const layers = [];
  let extraIndicators = [];
  let recoveredText = "";
  let workingText = text || "";

  if (!hasEncodingSignal(text, buffer)) {
    attempted.push("Deteksi layer proteksi (tidak diperlukan -- konten sudah berupa teks polos)");
  } else {
    let stop = false;
    for (let index = 1; index <= MAX_LAYERS && !stop; index += 1) {
      const methodsThisLayer = [];
      let layerOutput = "";
      let layerOpened = false;
      let nextText = workingText;

      // Replace each decoded candidate in place (rather than just
      // appending the output) so the next layer sees genuinely new content
      // instead of re-decoding the same still-present encoded blob forever.
      const tryMethod = (result) => {
        attempted.push(result.method);
        methodsThisLayer.push(result.method);
        if (result.results && result.results.length) {
          layerOpened = true;
          for (const r of result.results) {
            layerOutput += `\n${r.output}`;
            if (r.whole) {
              // Whole-buffer decodes (gzip/zlib) don't correspond to a
              // literal substring of the working text -- append the
              // decoded content so later layers/indicator scans can still
              // see it, rather than trying (and failing) to splice it in.
              nextText = `${nextText}\n${r.output}`;
            } else {
              nextText = nextText.split(r.input).join(` ${r.output} `);
            }
          }
        }
      };

      tryMethod(decoder.decodeStringCharCalls(workingText));
      tryMethod(decoder.decodeBase64Candidates(workingText));
      tryMethod(decoder.decodeHexEscapeCandidates(workingText));
      tryMethod(decoder.decodeUnicodeEscapeCandidates(workingText));
      tryMethod(decoder.decodeDecimalEscapeCandidates(workingText));
      tryMethod(decoder.decodeOctalEscapeCandidates(workingText));
      // XOR, gzip and zlib only make sense against raw bytes representing
      // an actual encoded blob -- only meaningful on the very first layer,
      // against the original file buffer.
      if (index === 1) {
        tryMethod(decoder.decodeXorBruteForce(buffer));
        tryMethod(decoder.decodeGzipBuffer(buffer));
        tryMethod(decoder.decodeZlibBuffer(buffer));
      }

      layers.push({ index, opened: layerOpened, methods: Array.from(new Set(methodsThisLayer)) });

      if (layerOpened) {
        recoveredText += layerOutput;
        extraIndicators = extraIndicators.concat(scanIndicators(layerOutput));
        // Feed the substituted text forward, in case it hides another
        // layer of encoding (e.g. base64-of-base64).
        workingText = nextText;
      } else {
        // This layer made no honest progress -- nothing left to peel.
        stop = true;
      }
    }
  }

  attempted.push("Hilangkan junk code sederhana");
  const junk = stripSimpleJunk(workingText);
  let finalText = junk.text;

  attempted.push("Inline local string literal (deteksi fragmented secret)");
  const inlined = inlineLocalStringLiterals(finalText);
  finalText = inlined.text;

  attempted.push("Simplify expression");
  const simplified = simplifyExpressions(finalText);
  finalText = simplified.text;

  if (junk.changed || inlined.changed || simplified.changed) {
    extraIndicators = extraIndicators.concat(scanIndicators(finalText));
  }

  const recovered = layers
    .filter((l) => l.opened)
    .map((l) => ({ method: l.methods.join(", ") || "Layer tanpa nama", layer: l.index }));

  return {
    attempted,
    recovered,
    layers,
    extraIndicators,
    recoveredText: recoveredText.trim(),
    simplifiedText: finalText,
  };
}
