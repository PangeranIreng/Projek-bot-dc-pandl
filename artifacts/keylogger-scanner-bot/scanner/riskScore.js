// Weighted 0-100 Confidence Score built PURELY by addition. Per spec, the
// bot must NEVER subtract points because a specific indicator was not found
// -- an obfuscator can simply be hiding it. Every point traces back to
// something actually observed: either a matched regex/AST indicator
// (heuristic/indicators.js, astAnalyzer.js, callGraphAnalyzer.js `weight`)
// or one of the computed obfuscation signals below (entropy, obfuscator
// match, string encryption density, a successfully-opened decode layer, or
// AST/bytecode structural complexity). There is no "reduction" table.

// Computed (non-regex) obfuscation signals and their point values.
export const OBFUSCATION_SIGNAL_WEIGHTS = {
  entropyHigh: { weight: 15, label: "Entropy Tinggi" },
  obfuscatorMatched: { weight: 15, label: "Obfuscator terdeteksi (dikenal atau tidak dikenal)" },
  stringEncryption: { weight: 10, label: "String Encryption (banyak string ter-encode)" },
  dynamicDecode: { weight: 10, label: "Dynamic Decode (layer proteksi berhasil dibuka)" },
  astComplexity: { weight: 10, label: "AST Complexity (struktur kode sangat kompleks)" },
};

// Regex/AST-detected indicator ids that are themselves obfuscation/evasion
// techniques (already carrying their own weight) but which should ALSO
// count toward the minimum-status floor below -- a file exhibiting several
// of these can never be reported AMAN just because the main behavior
// indicators weren't found (they could simply be hidden).
//
// Note: `luajitStripped` and `bytecodeLowStringDensity` are intentionally
// excluded. Stripped debug info is standard practice for distributed
// compiled Lua and is NOT on its own a sign of malicious intent. Counting
// it toward the obfuscation floor would unfairly penalize all legitimate
// compiled scripts. It still contributes a small additive weight to the
// raw score, but does not raise the minimum level.
const SOFT_OBFUSCATION_INDICATOR_IDS = new Set([
  "identifierAcak",
  "bit32Heavy",
  "xorSimple",
  "stringCharUsage",
  "controlFlowFlattening",
  "obfuscatorGeneric",
  "tableIndirection",
  "swizzleLookups",
  "encryptStringsMarker",
  "dummyFunctions",
  "mutatedLiterals",
  "revertedIfStatements",
  "sharedVM",
  "shuffleSegments",
  "globalsLookup",
  "customDecryptorStructural",
  "fragmentedEndpoint",
  "nestedFunctionAbuse",
  "suspiciousRecursion",
  "deepFunctionNesting",
  "astRecursionAbuse",
  "astControlFlowFlattening",
  "astGlobalsLookup",
  // luajitStripped excluded: stripped debug info is normal for compiled Lua
  "luajitFfi",
  // bytecodeLowStringDensity excluded: common in legitimate stripped bytecode
  "bytecodeInjection",
  "antiVM",
  "antiDebug",
  "antiDump",
  "antiHook",
  "antiDecompiler",
  "environmentDetection",
  "dynamicCodeConstruction",
  "embeddedBinaryPayload",
]);

// Indicator ids severe enough that finding *several at once* should escalate
// straight to CRITICAL regardless of the raw additive score -- a
// combination of keylogger + webhook + token stealer + remote execution is
// categorically worse than the sum of its parts suggests.
const CRITICAL_COMBINATION_IDS = new Set([
  "keylogger",
  "discordWebhook",
  "discordToken",
  "tokenGrabber",
  "credentialStealer",
  "browserPassword",
  "remoteCodeExecutionChain",
  "backdoorKeyword",
  "dataExfiltration",
  "osExecute",
]);

// The 4 scored categories, low to high. `UNKNOWN` is deliberately excluded
// -- it isn't a point on this scale, it's a distinct "analysis is
// incomplete / technique not recognized" outcome (see BAND_META below),
// decided in scorer.js from coverage rather than from the score.
const LEVEL_ORDER = ["AMAN", "PERLU_DICEK", "BERBAHAYA", "CRITICAL"];

const LEVEL_BANDS = [
  { max: 20, level: "AMAN" },
  { max: 50, level: "PERLU_DICEK" },
  { max: 80, level: "BERBAHAYA" },
  { max: 100, level: "CRITICAL" },
];

export function scoreToLevel(score) {
  for (const band of LEVEL_BANDS) {
    if (score <= band.max) return band.level;
  }
  return "CRITICAL";
}

export function forceMinimumLevel(level, minLevel) {
  const idx = Math.max(LEVEL_ORDER.indexOf(level), LEVEL_ORDER.indexOf(minLevel));
  return LEVEL_ORDER[idx < 0 ? 0 : idx];
}

// A heavily obfuscated (or entirely unreadable) file must NEVER show AMAN
// just because the main indicators (webhook/loadstring/downloader) weren't
// found -- they could simply be hidden by the obfuscator.
// `obfuscationSignalCount` raises a floor under the score-derived level: 1+
// signal keeps it at least PERLU_DICEK (⚠️), 3+ signals keep it at least
// BERBAHAYA (🚫).
export function applyObfuscationFloor(level, obfuscationSignalCount) {
  const floor = obfuscationSignalCount >= 3 ? "BERBAHAYA" : obfuscationSignalCount >= 1 ? "PERLU_DICEK" : "AMAN";
  return forceMinimumLevel(level, floor);
}

// 2+ independently-matched critical-severity indicators (e.g. a live
// webhook AND a keylogger pattern AND a discord token) is categorically
// CRITICAL -- multiple high-impact malware behaviors reinforcing each other
// is worse than what the additive score alone might land on.
export function applyCriticalFloor(level, criticalCombinationCount) {
  if (criticalCombinationCount >= 2) return forceMinimumLevel(level, "CRITICAL");
  return level;
}

// The 5-category result system. Cautious, non-absolute wording per band --
// the bot never states flatly that a file "aman" (safe) or "is a
// keylogger"; it always frames the result as what was observed so far.
export const BAND_META = {
  AMAN: {
    emoji: "🛡️",
    color: 0x2ecc71,
    colorName: "Hijau",
    range: "0-20",
    label: "AMAN",
    text: "Aman. Tidak ditemukan indikator berbahaya berdasarkan analisis saat ini.",
  },
  PERLU_DICEK: {
    emoji: "⚠️",
    color: 0xf1c40f,
    colorName: "Kuning",
    range: "21-50",
    label: "PERLU DICEK",
    text:
      "Perlu Dicek. Ada indikator ringan, namun belum cukup untuk menyatakan file ini berbahaya. Disarankan pemeriksaan manual sebelum menjalankan.",
  },
  BERBAHAYA: {
    emoji: "🚫",
    color: 0xe74c3c,
    colorName: "Merah",
    range: "51-80",
    label: "BERBAHAYA",
    text:
      "Berbahaya. Ditemukan indikator kuat yang mengarah pada malware. SANGAT DISARANKAN untuk tidak menjalankan file ini sebelum pemeriksaan lebih lanjut.",
  },
  CRITICAL: {
    emoji: "🚨",
    color: 0xdc143c,
    colorName: "Crimson (Merah Tua)",
    range: "81-100",
    label: "CRITICAL",
    text:
      "🚨 CRITICAL. Ditemukan indikator malware tingkat tinggi (mis. keylogger, token stealer, webhook stealer, downloader, RAT, remote execution) atau kombinasi beberapa indikator kritis yang saling memperkuat. JANGAN jalankan file ini.",
  },
  UNKNOWN: {
    emoji: "❓",
    color: 0x23272a,
    colorName: "Hitam / Abu-abu Gelap",
    range: "-",
    label: "UNKNOWN",
    text:
      "Bot belum mampu memastikan keamanan file ini karena analisis tidak lengkap (banyak bagian file masih belum bisa dibaca/dipulihkan) atau karena teknik proteksi yang digunakan belum dikenali. Ini BUKAN pernyataan bahwa file aman atau berbahaya.",
  },
};

/**
 * @param {Array<{id:string,label:string,weight:number,group:string,severity:string}>} dedupedIndicators
 *   already de-duplicated by id across all files/zip entries.
 * @param {{entropyHigh:boolean, obfuscatorMatched:boolean, stringEncryption:boolean, dynamicDecode:boolean, astComplexity:boolean}} obfuscationSignals
 */
export function computeRiskScore(dedupedIndicators, obfuscationSignals = {}) {
  const breakdown = [];
  let subtotal = 0;

  const scored = dedupedIndicators.filter((i) => i.weight > 0);
  // Show the highest-impact hits first so the breakdown reads like a real
  // audit report, not an unordered dump.
  scored.sort((a, b) => b.weight - a.weight);

  for (const ind of scored) {
    subtotal += ind.weight;
    breakdown.push({ delta: ind.weight, label: `${ind.label} ditemukan` });
  }

  // Computed obfuscation signals -- additive only.
  let obfuscationSignalCount = 0;
  for (const [key, meta] of Object.entries(OBFUSCATION_SIGNAL_WEIGHTS)) {
    if (obfuscationSignals[key]) {
      subtotal += meta.weight;
      breakdown.push({ delta: meta.weight, label: meta.label });
      obfuscationSignalCount += 1;
    }
  }

  const foundIds = new Set(dedupedIndicators.map((i) => i.id));
  for (const id of SOFT_OBFUSCATION_INDICATOR_IDS) {
    if (foundIds.has(id)) obfuscationSignalCount += 1;
  }

  let criticalCombinationCount = 0;
  for (const id of CRITICAL_COMBINATION_IDS) {
    if (foundIds.has(id)) criticalCombinationCount += 1;
  }

  const total = Math.max(0, Math.min(100, Math.round(subtotal)));
  let level = applyObfuscationFloor(scoreToLevel(total), obfuscationSignalCount);
  level = applyCriticalFloor(level, criticalCombinationCount);

  return { total, breakdown, level, obfuscationSignalCount, criticalCombinationCount };
}
