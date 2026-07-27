// Scoring engine. Turns everything gathered about a file (indicator hits,
// recovery results/percentage, parser/detector coverage) into one of the 5
// result categories (AMAN / PERLU_DICEK / BERBAHAYA / CRITICAL / UNKNOWN), a
// Confidence Score, and the supporting narrative fields (explanation,
// summary, smart conclusion, warning banner, detection reasons). Nothing
// here is randomized -- every number and every sentence traces back to
// something actually observed.

import { computeRiskScore, BAND_META } from "./riskScore.js";
import { isAstComplex } from "./astAnalyzer.js";

const KEYLOGGER_NOTE =
  "Bot menemukan beberapa pola yang umum digunakan untuk mengambil informasi pemain (keylogger/credential theft). Hal ini tidak otomatis berarti file berbahaya, tetapi memerlukan pemeriksaan lebih lanjut.";

// Below this Analysis Coverage %, a low/moderate score is NOT trustworthy
// evidence of safety -- it may just mean large parts of the file were never
// readable. Per spec, UNKNOWN covers exactly this "analysis incomplete"
// case. Strong evidence (score already in BERBAHAYA/CRITICAL territory)
// still gets reported regardless of coverage -- finding a live webhook in
// the 30% of the file we *could* read is real evidence, not a false
// positive from incomplete analysis.
const MIN_TRUSTED_COVERAGE_PERCENT = 60;
const UNKNOWN_SCORE_CEILING = 50; // PERLU_DICEK's own top bound

function fileLabel(fileName, isZipMember) {
  return isZipMember ? `${fileName}: ` : "";
}

function lineSuffix(indicator) {
  return indicator.line ? ` (baris ${indicator.line})` : "";
}

function buildExplanation(level, recoveryPercent, topLabels) {
  let base;
  if (recoveryPercent === null) {
    base = "Bot tidak dapat membaca isi file sama sekali, sehingga tidak ada yang bisa diperiksa lebih lanjut.";
  } else if (recoveryPercent >= 95) {
    base = "File berhasil dianalisis secara menyeluruh.";
  } else if (recoveryPercent > 0) {
    base =
      "File berhasil dianalisis sebagian. Masih terdapat proteksi sehingga sebagian isi file belum dapat diperiksa. Hasil ini bukan jaminan mutlak.";
  } else {
    base = "Bot tidak berhasil membuka proteksi pada file ini sama sekali, sehingga sebagian besar isi file tidak dapat diperiksa.";
  }

  if (level === "AMAN") {
    const why =
      topLabels.length > 0
        ? `Hanya ditemukan ${topLabels.join(", ")}, tanpa indikator pencurian data yang kuat.`
        : "Tidak ditemukan webhook, request jaringan mencurigakan, fungsi pengiriman data, maupun teknik obfuscation berat.";
    return `${base} ${why} Berdasarkan hasil analisis saat ini, file ini tampak aman untuk dijalankan.`;
  }

  const tail = `Berdasarkan hasil analisis saat ini: ${(BAND_META[level] || BAND_META.UNKNOWN).text}`;
  return `${base} ${tail}`;
}

function buildSummary(level, recoveryPercent) {
  const opened =
    recoveryPercent === null || recoveryPercent === 0
      ? "Tidak ada bagian file yang berhasil dibuka/diperiksa."
      : recoveryPercent >= 95
        ? "Seluruh isi file berhasil diperiksa."
        : "Sebagian isi file berhasil diperiksa.";
  const remaining =
    recoveryPercent !== null && recoveryPercent < 95
      ? "Masih terdapat bagian yang belum dapat dianalisis."
      : "Tidak ada bagian tersisa yang perlu dianalisis ulang.";
  return `Bot telah mencoba membuka proteksi file semaksimal mungkin. ${opened} ${remaining} Gunakan hasil ini sebagai referensi, bukan kepastian mutlak.`;
}

const WARNING_BANNER = {
  BERBAHAYA:
    "🚫 PERINGATAN\nBot menemukan indikator kuat yang mengarah pada malware.\nSANGAT DISARANKAN untuk TIDAK menjalankan file sebelum dilakukan pemeriksaan manual lebih lanjut.",
  CRITICAL:
    "🚨 PERINGATAN CRITICAL 🚨\nBot menemukan indikator malware tingkat tinggi (keylogger / token stealer / webhook stealer / downloader / RAT / remote execution) atau kombinasi beberapa indikator kritis.\nJANGAN JALANKAN file ini.",
};

// Cautious, non-absolute recommendations -- always framed as "berdasarkan
// analisis saat ini" / "belum ditemukan", never a flat guarantee.
const RECOMMENDATION = {
  AMAN: "Risiko rendah. Disarankan tetap melakukan pemeriksaan manual dan hanya mengunduh script dari sumber terpercaya, karena analisis otomatis tidak dapat menjamin 100% keamanan.",
  PERLU_DICEK: "Bukti yang ditemukan belum cukup untuk memastikan file ini aman. Disarankan tetap melakukan pemeriksaan manual sebelum menjalankan file, khususnya pada setiap indikator yang tercantum di bawah.",
  BERBAHAYA: "Risiko tinggi. Sangat tidak disarankan menjalankan file ini. Hapus dan laporkan jika didapat dari sumber yang tidak dikenal.",
  CRITICAL: "Risiko sangat tinggi. JANGAN jalankan file ini dalam kondisi apa pun. Hapus segera dan laporkan sumbernya.",
  UNKNOWN: "Bot tidak dapat memverifikasi isi file ini secara memadai (analisis belum lengkap atau teknik proteksi belum dikenali). Perlakukan dengan hati-hati dan jangan jalankan tanpa pemeriksaan manual.",
};

// Status line always frames the result as an observation, not a verdict --
// never a flat "file aman" / "Malware Detected" statement.
const STATUS_TEXT = {
  AMAN: "Tidak ditemukan indikator berbahaya berdasarkan analisis saat ini.",
  PERLU_DICEK: "Ada indikator ringan, namun belum cukup untuk menyatakan file ini berbahaya.",
  BERBAHAYA: "Ditemukan indikator kuat yang mengarah pada malware.",
  CRITICAL: "Ditemukan indikator malware tingkat tinggi atau kombinasi beberapa indikator kritis.",
  UNKNOWN: "Bot belum mampu memastikan keamanan file ini karena analisis tidak lengkap atau teknik yang digunakan belum dikenali.",
};

/**
 * Build a human, non-robotic "smart conclusion" narrative in the style of:
 * "Script ini memperoleh skor 82/100 karena ditemukan webhook Discord aktif,
 * fungsi pengiriman data, dan beberapa pola yang umum digunakan pada
 * keylogger. Walaupun sebagian isi file masih terlindungi oleh obfuscator,
 * indikator yang ditemukan sudah cukup kuat sehingga file dikategorikan
 * berisiko tinggi."
 */
function buildSmartConclusion({ level, score, topLabels, protectionMatched, recoveryPercent }) {
  if (level === "AMAN") {
    const causeText =
      topLabels.length > 0
        ? `Bot hanya menemukan ${topLabels.join(", ")} tanpa indikator pencurian data yang kuat.`
        : "Bot tidak menemukan pola mencurigakan yang berarti.";
    return `Script ini memperoleh skor ${score}/100. ${causeText} Tidak ditemukan webhook, request mencurigakan, maupun fungsi pengiriman informasi yang kuat sehingga file kemungkinan besar aman. Namun tetap disarankan mengunduh script hanya dari sumber terpercaya.`;
  }

  const causeText =
    topLabels.length > 0
      ? `karena ditemukan ${topLabels.join(", ")}`
      : "karena beberapa indikator yang saling memperkuat kecurigaan";
  const protectionText = protectionMatched
    ? " Walaupun sebagian isi file masih terlindungi oleh obfuscator,"
    : "";
  const recoveryText =
    recoveryPercent !== null && recoveryPercent < 95
      ? ` dan hanya sekitar ${recoveryPercent}% isi file yang berhasil dipulihkan,`
      : "";
  const tail =
    level === "CRITICAL"
      ? "kombinasi indikator yang ditemukan sudah sangat kuat sehingga file dikategorikan CRITICAL -- jangan dijalankan."
      : level === "BERBAHAYA"
        ? "indikator yang ditemukan sudah sangat kuat sehingga file dikategorikan BERBAHAYA."
        : "indikator yang ditemukan cukup untuk memerlukan pemeriksaan manual lebih lanjut (PERLU DICEK).";

  return `Script ini memperoleh skor ${score}/100 ${causeText}.${protectionText}${recoveryText} ${tail}`;
}

/**
 * @param {Array<{fileName:string,isZipMember:boolean,indicators:Array,recovery:Object,readable:boolean,unreadableReason:string|null}>} fileFindings
 * @param {{filesAnalyzed:number, filesTotal:number, anyTextExtracted:boolean, recoveryPercent:number|null, hasComments:boolean}} coverage
 */
export function assessThreat(fileFindings, coverage) {
  const reasons = [];
  const indicatorMap = new Map(); // id -> indicator (deduped across all files)
  let webhook = null;
  let keyloggerFound = false;

  const collect = (indicator, prefix) => {
    if (!indicatorMap.has(indicator.id)) indicatorMap.set(indicator.id, indicator);
    if (indicator.severity !== "info") {
      reasons.push(`${prefix}${indicator.label} ditemukan${lineSuffix(indicator)}.`);
    }
    if (indicator.id === "discordWebhook" && !webhook) webhook = indicator.samples[0];
    if (indicator.id === "keylogger") keyloggerFound = true;
  };

  for (const finding of fileFindings) {
    const prefix = fileLabel(finding.fileName, finding.isZipMember);

    if (!finding.readable) {
      reasons.push(`${prefix}${finding.unreadableReason || "File tidak dapat dibaca."}`);
      continue;
    }

    for (const indicator of finding.indicators) collect(indicator, prefix);

    if (finding.recovery?.recovered?.length) {
      reasons.push(
        `${prefix}Berhasil membuka ${finding.recovery.recovered.length} layer proteksi (${finding.recovery.recovered
          .map((r) => r.method)
          .join(", ")}).`,
      );
    }
    // Junk-code stripping / local-literal inlining / expression simplification
    // run unconditionally (independent of whether an actual encoding layer
    // was opened) -- so their rescanned indicators must always be merged in,
    // not just when `recovered.length` is non-zero. This is what surfaces a
    // webhook/token that was split across `local` string fragments and
    // joined with `..` even when no encoding/decoding was otherwise needed.
    for (const extra of finding.recovery?.extraIndicators || []) {
      collect(extra, `${prefix}(dari hasil deobfuscation) `);
    }

    const failedLayer = finding.recovery?.layers?.find((l) => !l.opened);
    if (failedLayer) {
      reasons.push(`${prefix}Layer ${failedLayer.index} gagal dibuka.`);
    }

    if (finding.entropySignal?.level === "high") {
      reasons.push(`${prefix}${finding.entropySignal.note}`);
    }
    if (finding.encryption?.matched) {
      reasons.push(`${prefix}${finding.encryption.note || `Enkripsi ${finding.encryption.type} terdeteksi.`}`);
    }
  }

  if (keyloggerFound) reasons.push(KEYLOGGER_NOTE);

  const recoveryPercent = coverage.recoveryPercent ?? null;

  // Compound rule: dynamic-execution primitive (load/loadstring) PLUS a
  // network/exfiltration channel (webhook, HTTP request lib, downloader,
  // pastebin/github raw) is a materially different, stronger claim than
  // either alone -- a real "fetch remote code and run it" chain -- so it
  // gets its own synthetic, additive indicator rather than just relying on
  // the two separate weights to happen to add up high enough.
  const hasIndicatorId = (id) =>
    fileFindings.some((f) => (f.indicators || []).some((i) => i.id === id));
  const hasDynamicExec = ["loadstringFn", "loadFn", "dynamicCodeConstruction"].some(hasIndicatorId);
  const hasNetworkChannel = [
    "discordWebhook",
    "requestFunction",
    "remoteDownload",
    "pastebin",
    "githubRaw",
    "remoteLoader",
  ].some(hasIndicatorId);
  if (hasDynamicExec && hasNetworkChannel) {
    const synthetic = {
      id: "remoteCodeExecutionChain",
      label: "Remote Code Execution Chain (load/loadstring dikombinasikan dengan pengambilan data dari jaringan)",
      severity: "critical",
      weight: 20,
      group: "execution",
      count: 1,
      samples: [],
    };
    collect(synthetic, "");
  }

  const dedupedIndicators = Array.from(indicatorMap.values());

  // --- UNKNOWN: either the file couldn't be read at all (bytecode header
  // unrecognized, no text extractable, no structural analysis possible), OR
  // enough of it stayed unreadable that a low/moderate score cannot be
  // trusted as real evidence of safety. Never used simply because a file
  // happens to be compiled -- `anyTextExtracted` is already true for any
  // bytecode file whose header/signature was successfully recognized (see
  // scanFile.js), even with zero extracted strings. Strong evidence
  // (score already at/above BERBAHAYA) is reported as-is regardless of
  // coverage -- a webhook found in the 30% we could read is still a
  // webhook.
  const totallyUnreadable = !coverage.anyTextExtracted || coverage.filesAnalyzed === 0;

  if (totallyUnreadable) {
    if (reasons.length === 0) {
      reasons.push("Semua metode analisis yang didukung telah dicoba, termasuk analisis struktural untuk file terkompilasi.");
      reasons.push("File tidak dapat dianalisis sepenuhnya karena kemungkinan rusak (corrupted) atau format tidak didukung.");
    }
    return {
      level: "UNKNOWN",
      statusText: STATUS_TEXT.UNKNOWN,
      confidence: null,
      recoveryPercent: 0,
      riskScore: null,
      riskBreakdown: [],
      indicators: [],
      matchedIndicatorCount: 0,
      analysisCoveragePercent: 0,
      reasons,
      explanation: buildExplanation("UNKNOWN", null, []),
      summary: buildSummary("UNKNOWN", 0),
      conclusion:
        "Semua metode analisis yang didukung telah dicoba (termasuk analisis struktural untuk file terkompilasi), namun file tidak dapat dianalisis sepenuhnya karena kemungkinan rusak (corrupted) atau format yang tidak didukung. Bot tidak mengarang hasil untuk file ini.",
      recommendation: RECOMMENDATION.UNKNOWN,
      webhook,
      banner: null,
    };
  }

  // Build the additive obfuscation-signal object from what was actually
  // observed across all files/zip entries -- each flag traces back to a
  // concrete finding (never guessed): high byte entropy, a matched
  // obfuscator/protection signature (named or structurally suspicious), a
  // matched named-cipher/high-entropy encryption result, at least one
  // recovery layer that genuinely opened, or AST/bytecode structure that
  // looks complex/flattened/stripped.
  const obfuscationSignals = {
    entropyHigh: fileFindings.some((f) => f.entropySignal?.level === "high"),
    obfuscatorMatched: fileFindings.some((f) => f.protection?.matched),
    stringEncryption: fileFindings.some((f) => f.encryption?.matched),
    dynamicDecode: fileFindings.some((f) => f.recovery?.recovered?.length > 0),
    astComplexity: fileFindings.some((f) => isAstComplex(f.astStats)),
  };

  const { total: riskScore, breakdown: riskBreakdown, level: scoredLevel } = computeRiskScore(
    dedupedIndicators,
    obfuscationSignals,
  );

  // Confidence Score IS the weighted Risk Score (0-100) -- it is not a
  // separate formula, and it is ALWAYS computed whenever the file could be
  // read at all (this branch only runs once anyTextExtracted is true).
  // "Analysis Coverage" (how much of the file could be read) is reported
  // separately and never conflated with this number.
  const confidence = riskScore;

  // Analysis incomplete + no strong evidence yet == genuinely UNKNOWN, not
  // "probably safe". Strong evidence (already BERBAHAYA/CRITICAL) is never
  // downgraded just because coverage was partial.
  const coverageInsufficient =
    recoveryPercent !== null && recoveryPercent < MIN_TRUSTED_COVERAGE_PERCENT && riskScore <= UNKNOWN_SCORE_CEILING;

  const level = coverageInsufficient ? "UNKNOWN" : scoredLevel;

  const topLabels = dedupedIndicators
    .filter((i) => i.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((i) => i.label.toLowerCase());

  const protectionMatched = fileFindings.some((f) => f.protection?.matched);

  // Analysis Coverage: how much of the file's content the bot was actually
  // able to turn into analyzable text/structure -- reuses the
  // already-computed recovery percentage (0-100), never left blank.
  const analysisCoveragePercent = recoveryPercent ?? 100;

  if (level === "UNKNOWN") {
    reasons.push(
      `Analysis Coverage hanya ${analysisCoveragePercent}% dan belum ditemukan indikator kuat -- bot tidak dapat memastikan file ini aman atau berbahaya dari bagian yang belum terbaca.`,
    );
    return {
      level,
      statusText: STATUS_TEXT.UNKNOWN,
      confidence,
      recoveryPercent,
      analysisCoveragePercent,
      riskScore,
      riskBreakdown,
      indicators: dedupedIndicators,
      matchedIndicatorCount: dedupedIndicators.length,
      reasons,
      explanation: buildExplanation("UNKNOWN", recoveryPercent, topLabels),
      summary: buildSummary("UNKNOWN", recoveryPercent),
      conclusion: `Script ini memperoleh skor ${riskScore}/100, namun hanya ${analysisCoveragePercent}% isi file yang berhasil dianalisis. Karena cakupan analisis belum cukup dan belum ditemukan indikator kuat, bot tidak dapat memastikan apakah file ini aman atau berbahaya.`,
      recommendation: RECOMMENDATION.UNKNOWN,
      webhook,
      banner: null,
    };
  }

  return {
    level,
    statusText: STATUS_TEXT[level],
    confidence,
    recoveryPercent,
    analysisCoveragePercent,
    riskScore,
    riskBreakdown,
    // Deduped indicator list surfaced for the Full Preview button -- kept
    // as the raw indicator objects (id/label/severity/samples/line) rather
    // than pre-formatted text, so the preview builder can lay them out
    // fully.
    indicators: dedupedIndicators,
    matchedIndicatorCount: dedupedIndicators.length,
    reasons: reasons.length
      ? reasons
      : ["Tidak ditemukan pola mencurigakan yang cukup kuat untuk menaikkan level risiko."],
    explanation: buildExplanation(level, recoveryPercent, topLabels),
    summary: buildSummary(level, recoveryPercent),
    conclusion: buildSmartConclusion({
      level,
      score: riskScore,
      topLabels,
      protectionMatched,
      recoveryPercent,
    }),
    recommendation: RECOMMENDATION[level],
    webhook,
    banner: WARNING_BANNER[level] || null,
  };
}
