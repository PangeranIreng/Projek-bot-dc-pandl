// Reporting engine. Combines the scorer's verdict with everything the
// detector/parser/recovery pipeline learned (protection name, Lua variant,
// which methods were attempted, the analysis checklist) into the flat
// result object the Discord embed builder renders. This is the only place
// presentation-level text decisions are made per level.

import { formatBytes, truncate } from "../utils/fileUtils.js";

// Per spec: if a known obfuscator signature actually matched, name it.
// Otherwise the field hinges purely on whether there is ANY structural/
// encoded-density evidence of protection at all (`protection.matched`) --
// not on the overall severity level, since a plain, unobfuscated malicious
// script (readable webhook/keylogger code with zero encoding) is a
// completely different, more honest story than "we can't tell what
// obfuscator this is": the former genuinely shows no obfuscation, the
// latter gets the literal "UNKNOWN" label per spec.
function formatObfuscatorLabel(protection) {
  if (protection?.recognized) return protection.name;
  if (protection?.matched) return "UNKNOWN";
  return "Tidak Terdeteksi (tidak ada tanda-tanda obfuscation)";
}

/**
 * Build the final, presentation-ready result object.
 */
export function buildReport({
  fileName,
  sizeBytes,
  scanTimeMs,
  fileTypeLabel,
  luaVariant,
  protection,
  attemptedMethods,
  assessment,
  analysisChecklist = [],
  webhookStatus = null,
  extra = {},
}) {
  return {
    fileName,
    fileSizeLabel: formatBytes(sizeBytes),
    scanTimeMs,
    fileTypeLabel: fileTypeLabel || "Tidak Dapat Dipastikan",
    luaVariant: luaVariant || "Tidak dapat diklasifikasikan",
    protection: formatObfuscatorLabel(protection),
    level: assessment.level,
    // `null` confidence means "Tidak dapat dihitung" (TIDAK_DAPAT_DIPASTIKAN only).
    confidence: assessment.confidence,
    recoveryPercent: assessment.recoveryPercent,
    analysisCoveragePercent: assessment.analysisCoveragePercent ?? assessment.recoveryPercent ?? 0,
    matchedIndicatorCount: assessment.matchedIndicatorCount ?? (assessment.indicators || []).length,
    statusText: assessment.statusText,
    reasons: assessment.reasons.map((r) => truncate(r, 300)),
    explanation: assessment.explanation,
    summary: assessment.summary,
    conclusion: assessment.conclusion,
    recommendation: assessment.recommendation,
    banner: assessment.banner,
    webhook: assessment.webhook,
    webhookStatus: assessment.webhook ? webhookStatus : null,
    attemptedMethods: Array.from(new Set(attemptedMethods || [])),
    analysisChecklist,
    // Carried through for the Full Preview button -- the deduped indicator
    // list and the weighted Risk Score breakdown behind the Confidence
    // Score, plus whatever per-file raw fields (entropySignal, decodeLayers,
    // astInfo) the caller attaches via `extra`.
    riskScore: assessment.riskScore,
    riskBreakdown: assessment.riskBreakdown || [],
    indicators: assessment.indicators || [],
    ...extra,
  };
}

/**
 * Build a well-formed UNKNOWN report for cases that never reach the scorer
 * at all (oversized attachment, download/parse crash, unsupported format
 * before any analysis could run). Keeps the result shape identical to
 * buildReport() so the embed builder never has to special-case callers.
 */
export function buildUnknownReport({ fileName, sizeBytes, scanTimeMs, reason, fileTypeLabel }) {
  return {
    fileName,
    fileSizeLabel: formatBytes(sizeBytes),
    scanTimeMs: scanTimeMs ?? 0,
    fileTypeLabel: fileTypeLabel || "Tidak Dapat Dipastikan",
    luaVariant: "Tidak dapat diklasifikasikan",
    protection: "UNKNOWN",
    luaVersion: null,
    luaVersionSource: null,
    level: "UNKNOWN",
    confidence: null,
    recoveryPercent: 0,
    analysisCoveragePercent: 0,
    matchedIndicatorCount: 0,
    statusText: "Bot tidak dapat memastikan keamanan file ini karena file tidak dapat diproses sama sekali.",
    reasons: [reason],
    explanation:
      "Bot tidak dapat membaca isi file sama sekali, sehingga tidak ada yang bisa diperiksa lebih lanjut.",
    summary:
      "Bot telah mencoba membuka proteksi file semaksimal mungkin, termasuk analisis struktural untuk file terkompilasi. Tidak ada bagian file yang berhasil dibuka/diperiksa. Gunakan hasil ini sebagai referensi, bukan kepastian mutlak.",
    conclusion:
      "Analisis tidak dapat diselesaikan karena file kemungkinan rusak (corrupted) atau menggunakan format yang tidak didukung. Bot tidak mengarang hasil untuk file ini.",
    recommendation:
      "Bot tidak dapat memverifikasi isi file ini secara memadai. Perlakukan dengan hati-hati dan jangan jalankan tanpa pemeriksaan manual.",
    banner: null,
    webhook: null,
    webhookStatus: null,
    attemptedMethods: [reason],
    analysisChecklist: [],
    riskScore: null,
    riskBreakdown: [],
    indicators: [],
  };
}
