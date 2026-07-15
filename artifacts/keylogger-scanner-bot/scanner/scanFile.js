// Top-level orchestrator. Runs the full pipeline in the required order --
// detect type -> detect Lua source/bytecode -> detect obfuscator/encryption/
// packer (incl. entropy) -> recover strings/decode layer by layer -> analyze
// bytecode if possible -> re-scan recovered output -> check any Discord
// webhook found is still live -- and only falls back to UNKNOWN once every
// supported method has genuinely been tried and still produced nothing
// usable. Never throws: any unexpected failure is caught and surfaced as a
// well-formed UNKNOWN result instead of crashing the caller.

import { detectFileType, detectProtection, detectEncryption, detectEncryptionType, classifyLuaVariant } from "./detector.js";
import { parseLuaBytecodeHeader, parseLuaSourceAst, detectLuaSourceVersion } from "./parser.js";
import { scanIndicators } from "./heuristic.js";
import { runRecoveryPipeline } from "./deobfuscator.js";
import { analyzeAstStructure, astStatsToIndicators, isAstComplex } from "./astAnalyzer.js";
import { analyzeCallGraph, callGraphStatsToIndicators } from "./callGraphAnalyzer.js";
import { extractZipEntries } from "./zipScanner.js";
import { assessThreat } from "./scorer.js";
import { buildReport, buildUnknownReport } from "./report.js";
import { checkWebhookStatus } from "./webhookChecker.js";
import { printableRatio } from "../utils/fileUtils.js";
import crypto from "node:crypto";

// Content-hash cache: identical bytes (same file re-uploaded, or the same
// entry duplicated inside a zip) are scanned once and the exact same report
// object (minus the per-call scanTimeMs/fileName, which are patched back in)
// is reused. Bounded to a small in-memory LRU-by-insertion-order map so a
// long-running bot process doesn't grow unbounded; correctness never
// depends on the cache -- a cold cache just means a normal fresh scan.
const scanCache = new Map();
const MAX_CACHE_ENTRIES = 200;

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function cacheGet(key) {
  if (!scanCache.has(key)) return null;
  // Refresh recency by re-inserting at the end (Map preserves insertion order).
  const value = scanCache.get(key);
  scanCache.delete(key);
  scanCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  scanCache.set(key, value);
  while (scanCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = scanCache.keys().next().value;
    scanCache.delete(oldestKey);
  }
}

const SUPPORTED_EXTENSIONS = new Set([
  ".lua",
  ".luac",
  ".js",
  ".py",
  ".txt",
  ".json",
  ".zip",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
]);

// How much of a file's content was actually turned into analyzable text.
// Combines how many recovery layers genuinely opened with how printable the
// final accumulated text is -- so a lucky single decode on a mostly-still-
// opaque blob doesn't get reported as "fully recovered".
function computeRecoveryPercent({ recovery, text, buffer, bytecodeVerified }) {
  if (!recovery || !recovery.layers || recovery.layers.length === 0) {
    // No protection signal was detected at all -- nothing needed opening.
    return 100;
  }
  const layersAttempted = recovery.layers.length;
  const layersOpened = recovery.layers.filter((l) => l.opened).length;
  const combinedText = `${text || ""}\n${recovery.recoveredText || ""}`;
  const finalRatio = printableRatio(Buffer.from(combinedText, "utf8"));
  let percent = Math.round(((layersOpened / layersAttempted) * 0.5 + finalRatio * 0.5) * 100);
  if (bytecodeVerified === false) percent = Math.max(0, percent - 30);
  return Math.max(0, Math.min(100, percent));
}

// Structural heuristics computed directly from the LuaJIT bytecode header
// bitfield and raw string-extraction density -- these are the "structural
// analysis" signals that let a compiled/stripped file still receive a real
// Confidence Score even when it has few or zero extractable strings.
// Nothing here is guessed: every entry traces back to a concrete header
// flag or a concrete count.
function bytecodeStructuralIndicators(luaInfo, buffer) {
  const indicators = [];
  if (luaInfo.isLuaJit) {
    if (luaInfo.strippedDebugInfo === true) {
      // Stripped debug info is standard for distributed LuaJIT bytecode --
      // it's normal practice, not inherently suspicious. Weight is kept low
      // and it is explicitly excluded from the obfuscation floor in
      // riskScore.js so legitimate compiled scripts don't get unfairly
      // penalized.
      indicators.push({
        id: "luajitStripped",
        label: "Bytecode LuaJIT tanpa debug info (stripped) — umum pada bytecode distribusi, bukan indikator tunggal",
        severity: "info",
        weight: 2,
        group: "obfuscation",
        count: 1,
        samples: [],
      });
    }
    if (luaInfo.usesFfi === true) {
      indicators.push({
        id: "luajitFfi",
        label: "Bytecode LuaJIT menggunakan FFI (akses memori/pointer native)",
        severity: "medium",
        weight: 5,
        group: "execution",
        count: 1,
        samples: [],
      });
    }
  }
  // A bytecode file of non-trivial size with almost no extractable printable
  // strings is a mild structural note. Normal stripped bytecode may have
  // very few constants, so the weight is intentionally low and this indicator
  // is excluded from the obfuscation floor (riskScore.js) so it doesn't
  // push legitimate compiled files to PERLU_DICEK on its own.
  if (buffer.length > 512 && luaInfo.extractedStrings.length <= 1) {
    indicators.push({
      id: "bytecodeLowStringDensity",
      label: "Bytecode padat dengan sedikit string yang dapat diekstrak — bisa normal untuk bytecode yang distrip",
      severity: "info",
      weight: 2,
      group: "obfuscation",
      count: 1,
      samples: [],
    });
  }
  return indicators;
}

function buildChecklist({ readable, hasText, hasWebhookCheck, protection, recoveryPercent, isLuac, bytecodeVerified }) {
  const items = [
    { icon: readable ? "✔" : "⚠", label: readable ? "Source diproses" : "Source tidak dapat diproses" },
    { icon: hasText ? "✔" : "⚠", label: hasText ? "String diekstrak" : "Tidak ada string yang dapat diekstrak" },
    { icon: "✔", label: "URL diperiksa" },
    { icon: "✔", label: "Discord Webhook diperiksa" },
    { icon: "✔", label: "Fungsi berisiko diperiksa" },
  ];
  if (protection?.matched && recoveryPercent < 100) {
    items.push({ icon: "⚠", label: "Obfuscation masih tersisa" });
  }
  if (isLuac && (bytecodeVerified === false || recoveryPercent < 100)) {
    items.push({ icon: "⚠", label: "Bytecode belum seluruhnya dipulihkan" });
  }
  return items;
}

/**
 * Fully analyze a single (non-zip) file buffer, trying every applicable
 * method before deciding whether it was "readable". Returns a finding
 * consumed by the scorer, plus detector/parser metadata for the report.
 */
function analyzeSingleFile(name, buffer, { isZipMember }) {
  const type = detectFileType(name, buffer);
  const attemptedMethods = [];
  const entropySignal = detectEncryption(buffer);
  attemptedMethods.push("Analisis entropy");

  if (!SUPPORTED_EXTENSIONS.has(type.extension) && !type.isLuac && !type.isZip) {
    return {
      fileName: name,
      isZipMember,
      readable: false,
      unreadableReason: "Format tidak didukung.",
      indicators: [],
      recovery: null,
      anyTextExtracted: false,
      attemptedMethods: ["Deteksi tipe file", "Analisis entropy"],
      luaVariant: null,
      protection: { name: "Tidak terdeteksi", matched: false, recognized: false },
      luaVersion: null,
      luaVersionSource: null,
      recoveryPercent: 0,
      entropySignal,
      analysisChecklist: [{ icon: "⚠", label: "Format tidak didukung, tidak dapat diproses" }],
    };
  }
  attemptedMethods.push("Deteksi tipe file");

  // --- Lua bytecode path: parse header, extract embedded strings, then
  // still run the full recovery pipeline over the extracted strings so
  // decode/deobfuscation get a real chance before giving up.
  if (type.isLuac) {
    attemptedMethods.push("Deteksi Lua Bytecode");
    const luaInfo = parseLuaBytecodeHeader(buffer);
    attemptedMethods.push("Analisis bytecode");
    attemptedMethods.push("Analisis struktural bytecode (header flags, densitas string)");

    const extractedText = luaInfo.extractedStrings.join("\n");
    const structuralIndicators = bytecodeStructuralIndicators(luaInfo, buffer);
    const indicators = scanIndicators(extractedText).concat(structuralIndicators);
    const recovery = runRecoveryPipeline(buffer, extractedText);
    attemptedMethods.push(...recovery.attempted);
    if (recovery.recoveredText) attemptedMethods.push("Scan ulang hasil recovery");

    const encryptionType = detectEncryptionType(extractedText, buffer);
    attemptedMethods.push("Deteksi tipe enkripsi (AES/RC4/XOR/Custom)");

    const anyTextExtracted = luaInfo.parsed || extractedText.length > 0 || recovery.recoveredText.length > 0;
    const protection = detectProtection(extractedText + "\n" + recovery.recoveredText);
    const luaVariant = classifyLuaVariant({
      extension: type.extension,
      isLuaBytecode: true,
      isLuaJit: luaInfo.isLuaJit,
      text: extractedText,
      printable: printableRatio(buffer),
      protection,
      astParsed: false,
    });
    const recoveryPercent = computeRecoveryPercent({
      recovery,
      text: extractedText,
      buffer,
      bytecodeVerified: luaInfo.parsed,
    });

    return {
      fileName: name,
      isZipMember,
      readable: anyTextExtracted,
      unreadableReason: anyTextExtracted
        ? null
        : luaInfo.reason || "Bytecode Lua tidak dapat diparsing dan tidak ada string yang dapat diekstrak.",
      indicators,
      recovery,
      anyTextExtracted,
      attemptedMethods,
      luaVariant,
      protection,
      encryption: encryptionType,
      luaVersion: luaInfo.version,
      recoveryPercent,
      entropySignal,
      analysisChecklist: buildChecklist({
        readable: anyTextExtracted,
        hasText: extractedText.length > 0 || recovery.recoveredText.length > 0,
        protection,
        recoveryPercent,
        isLuac: true,
        bytecodeVerified: luaInfo.parsed,
      }),
    };
  }

  // --- Everything else: source/text files (and .zip-member leftovers that
  // fell through, e.g. unsupported extensions nested in an archive).
  const ratio = printableRatio(buffer);
  const text = buffer.toString("utf8");
  attemptedMethods.push("Deteksi encrypted/packer (rasio karakter tercetak)");

  let astInfo = { attempted: false, parsed: false, error: null };
  let astStats = null;
  let astIndicators = [];
  let luaVersionSource = null;
  if (type.extension === ".lua") {
    luaVersionSource = detectLuaSourceVersion(text);
    attemptedMethods.push("Deteksi versi Lua dari sintaks source");
    astInfo = parseLuaSourceAst(text);
    attemptedMethods.push("Parse AST");
    if (astInfo.parsed && astInfo.ast) {
      try {
        astStats = analyzeAstStructure(astInfo.ast);
        astIndicators = astStatsToIndicators(astStats);
        attemptedMethods.push("Analisis struktur AST (nested function, rekursi, control flow flattening, globals lookup)");
      } catch {
        // Parse succeeded a moment ago via parseLuaSourceAst but structural
        // analysis failed unexpectedly -- skip it honestly, don't fabricate.
      }
      try {
        const callGraphStats = analyzeCallGraph(astInfo.ast);
        astIndicators = astIndicators.concat(callGraphStatsToIndicators(callGraphStats));
        attemptedMethods.push("Analisis Call Graph & Dynamic Code Construction (load/loadstring/dofile) & Dead Code");
      } catch {
        // Same honesty rule -- a failure here just means we skip the signal.
      }
    }
  }

  const encryptionType = detectEncryptionType(text, buffer);
  attemptedMethods.push("Deteksi tipe enkripsi (AES/RC4/XOR/Custom)");

  const indicators = scanIndicators(text).concat(astIndicators);
  const recovery = runRecoveryPipeline(buffer, text);
  attemptedMethods.push(...recovery.attempted);
  if (recovery.recoveredText) attemptedMethods.push("Scan ulang hasil recovery");

  const anyTextExtracted =
    (buffer.length > 0 && ratio >= 0.5) || recovery.recoveredText.length > 0 || astInfo.parsed;

  const combinedTextForProtection = `${text}\n${recovery.recoveredText}`;
  const protection = detectProtection(combinedTextForProtection);
  const luaVariant =
    type.extension === ".lua" || type.isLuac
      ? classifyLuaVariant({
          extension: type.extension,
          isLuaBytecode: false,
          isLuaJit: false,
          text,
          printable: ratio,
          protection,
          astParsed: astInfo.parsed,
        })
      : null;
  const recoveryPercent = computeRecoveryPercent({ recovery, text, buffer });

  // RAR/7z/EXE/DLL: no extraction/disassembly library is available, so we
  // never claim to have decompiled or fully unpacked these. We still run
  // entropy + raw-string indicator scanning + the decode pipeline over
  // whatever bytes are there (which does catch e.g. a plaintext webhook
  // embedded in an EXE), but say so honestly instead of pretending this is
  // equivalent to analyzing a Lua/JS/Python source file.
  const containerNote = type.isLimitedContainer
    ? "Format container/executable ini tidak dapat diekstrak atau di-disassemble sepenuhnya oleh scanner ini (tidak ada decompiler RAR/7z/PE). Hanya entropy dan string mentah yang dapat langsung diekstrak yang diperiksa."
    : null;

  return {
    fileName: name,
    isZipMember,
    readable: anyTextExtracted,
    unreadableReason: anyTextExtracted
      ? containerNote
      : containerNote ||
        "File terenkripsi/di-pack dan tidak dapat dibaca sebagai teks; semua metode decode/deobfuscation yang didukung telah dicoba tanpa hasil.",
    indicators,
    recovery,
    anyTextExtracted,
    attemptedMethods,
    luaVariant,
    protection,
    encryption: encryptionType,
    luaVersion: null,
    luaVersionSource,
    astInfo: { attempted: astInfo.attempted, parsed: astInfo.parsed, error: astInfo.error, statementCount: astInfo.statementCount },
    astStats,
    recoveryPercent,
    entropySignal,
    isLimitedContainer: type.isLimitedContainer,
    analysisChecklist: buildChecklist({
      readable: anyTextExtracted,
      hasText: text.length > 0 || recovery.recoveredText.length > 0,
      protection,
      recoveryPercent,
      isLuac: false,
    }).concat(
      type.isLimitedContainer
        ? [{ icon: "⚠", label: "Format container terbatas (RAR/7z/EXE/DLL) — tidak dapat diekstrak/decompile penuh" }]
        : [],
    ),
  };
}

function mergeChecklists(findings) {
  const merged = new Map();
  for (const finding of findings) {
    for (const item of finding.analysisChecklist || []) {
      const existing = merged.get(item.label);
      // Prefer a warning icon over a checkmark if any entry warns.
      if (!existing || item.icon === "⚠") merged.set(item.label, item);
    }
  }
  return Array.from(merged.values());
}

/**
 * Top-level entry point: analyze one Discord attachment's bytes. Never
 * throws -- any unexpected failure is caught and surfaced as UNKNOWN.
 * Content-hash cached: re-scanning byte-identical content (same file
 * re-uploaded, or duplicated inside a zip) skips straight to the cached
 * report instead of redoing the full pipeline -- only scanTimeMs/fileName
 * are refreshed for the new call so the report still describes THIS
 * upload.
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {number} declaredSize
 */
export async function scanFile(buffer, fileName, declaredSize) {
  const cacheKey = hashBuffer(buffer);
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { ...cached, fileName, scanTimeMs: 0, cached: true };
  }
  const report = await scanFileUncached(buffer, fileName, declaredSize);
  // Never cache a report that only exists because of an unexpected crash --
  // a transient environment issue shouldn't get permanently remembered as
  // "this content is unscannable".
  if (
    report.level !== "UNKNOWN" ||
    !report.reasons?.some((r) => r.startsWith("Terjadi kesalahan tak terduga"))
  ) {
    cacheSet(cacheKey, report);
  }
  return report;
}

async function scanFileUncached(buffer, fileName, declaredSize) {
  const startedAt = Date.now();

  try {
    const type = detectFileType(fileName, buffer);

    if (!SUPPORTED_EXTENSIONS.has(type.extension) && !type.isZip && !type.isLuac) {
      return buildUnknownReport({
        fileName,
        sizeBytes: buffer.length,
        scanTimeMs: Date.now() - startedAt,
        fileTypeLabel: type.label,
        reason: "Format tidak didukung oleh scanner ini.",
      });
    }

    if (type.isZip) {
      const zip = extractZipEntries(buffer);
      if (!zip.ok) {
        return buildUnknownReport({
          fileName,
          sizeBytes: buffer.length,
          scanTimeMs: Date.now() - startedAt,
          fileTypeLabel: type.label,
          reason: zip.error,
        });
      }

      const findings = zip.entries.map((entry) => {
        if (entry.error || !entry.buffer) {
          return {
            fileName: entry.name,
            isZipMember: true,
            readable: false,
            unreadableReason: entry.error || "Gagal membaca entri ZIP.",
            indicators: [],
            recovery: null,
            anyTextExtracted: false,
            attemptedMethods: ["Ekstraksi ZIP"],
            recoveryPercent: 0,
            analysisChecklist: [{ icon: "⚠", label: `Entri ${entry.name} gagal dibaca` }],
          };
        }
        return analyzeSingleFile(entry.name, entry.buffer, { isZipMember: true });
      });

      const filesAnalyzed = findings.filter((f) => f.readable).length;
      const anyTextExtracted = findings.some((f) => f.anyTextExtracted);
      const attemptedMethods = ["Ekstraksi ZIP", ...findings.flatMap((f) => f.attemptedMethods || [])];
      const recoveryPercent =
        findings.length > 0
          ? Math.round(findings.reduce((sum, f) => sum + (f.recoveryPercent || 0), 0) / findings.length)
          : 0;

      const assessment = assessThreat(findings, {
        filesAnalyzed,
        filesTotal: findings.length,
        anyTextExtracted,
        recoveryPercent,
      });

      if (zip.skippedForSize > 0 || zip.skippedForCount > 0) {
        assessment.reasons.push(
          `${zip.skippedForSize + zip.skippedForCount} entri dalam ZIP dilewati karena melebihi batas ukuran/jumlah file.`,
        );
      }

      const webhookStatus = assessment.webhook ? await checkWebhookStatus(assessment.webhook) : null;

      return buildReport({
        fileName,
        sizeBytes: buffer.length,
        scanTimeMs: Date.now() - startedAt,
        fileTypeLabel: type.label,
        luaVariant: null,
        protection: { name: "Tidak terdeteksi", matched: false, recognized: false },
        attemptedMethods,
        assessment,
        analysisChecklist: mergeChecklists(findings),
        webhookStatus,
        extra: {
          zipEntryCount: zip.totalEntries,
          entropySignal: findings.find((f) => f.entropySignal)?.entropySignal || null,
          astInfo: findings.find((f) => f.astInfo?.attempted)?.astInfo || null,
          isLimitedContainer: findings.some((f) => f.isLimitedContainer),
          luaVersion: findings.find((f) => f.luaVersion)?.luaVersion || null,
          luaVersionSource: findings.find((f) => f.luaVersionSource)?.luaVersionSource || null,
        },
      });
    }

    const finding = analyzeSingleFile(fileName, buffer, { isZipMember: false });
    const assessment = assessThreat([finding], {
      filesAnalyzed: finding.readable ? 1 : 0,
      filesTotal: 1,
      anyTextExtracted: finding.anyTextExtracted,
      recoveryPercent: finding.recoveryPercent,
    });

    const webhookStatus = assessment.webhook ? await checkWebhookStatus(assessment.webhook) : null;

    return buildReport({
      fileName,
      sizeBytes: buffer.length,
      scanTimeMs: Date.now() - startedAt,
      fileTypeLabel: type.label,
      luaVariant: finding.luaVariant,
      protection: finding.protection,
      attemptedMethods: finding.attemptedMethods,
      assessment,
      analysisChecklist: finding.analysisChecklist,
      webhookStatus,
      extra: {
        luaVersion: finding.luaVersion,
        luaVersionSource: finding.luaVersionSource || null,
        entropySignal: finding.entropySignal || null,
        astInfo: finding.astInfo || null,
        isLimitedContainer: finding.isLimitedContainer || false,
        decodeLayers: finding.recovery?.layers || [],
      },
    });
  } catch (err) {
    return buildUnknownReport({
      fileName,
      sizeBytes: declaredSize ?? 0,
      scanTimeMs: Date.now() - startedAt,
      reason: `Terjadi kesalahan tak terduga saat analisis: ${err.message}`,
    });
  }
}
