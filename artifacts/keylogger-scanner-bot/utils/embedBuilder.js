import { EmbedBuilder } from "discord.js";
import { truncate } from "./fileUtils.js";
import { BAND_META } from "../scanner/riskScore.js";

/**
 * Build the concise Discord embed for a single scan result. Full detail
 * (entropy, decoded layers, AST, full indicator list, risk breakdown) is
 * intentionally left out here and only shown via the "Full Preview" button
 * -- this embed is meant to be scannable at a glance, but every field
 * below is always populated with something meaningful -- never left blank.
 * @param {ReturnType<typeof import('../scanner/scanFile.js').scanFile>} result (awaited)
 */
export function buildScanEmbed(result) {
  const meta = BAND_META[result.level] || BAND_META.UNKNOWN;

  const hasScore = result.confidence !== null && result.confidence !== undefined;
  const confidenceText = hasScore ? `${result.confidence}/100` : "Tidak dapat dihitung";

  // Embed title includes the score so the verdict is visible at a glance
  // even when the embed is collapsed.
  const titleScore = hasScore ? ` [${result.confidence}/100]` : "";
  const title = `${meta.emoji} Hasil Scan — ${meta.label}${titleScore}`;

  const coverageText =
    result.analysisCoveragePercent === null || result.analysisCoveragePercent === undefined
      ? "0%"
      : `${result.analysisCoveragePercent}%`;

  const matchedCount = result.matchedIndicatorCount ?? (result.indicators || []).length;

  // Lua info: show one contextual line covering both source version and
  // bytecode version rather than two separate "Tidak relevan" rows.
  let luaInfoText;
  if (result.luaVersion) {
    // Compiled bytecode: show what version and note it is normal compiled code.
    luaInfoText = `${result.luaVersion} (bytecode terkompilasi)`;
  } else if (result.luaVersionSource) {
    luaInfoText = `${result.luaVersionSource} (source)`;
  } else if (result.luaVariant && result.luaVariant !== "Tidak dapat diklasifikasikan") {
    luaInfoText = result.luaVariant;
  } else {
    luaInfoText = "Tidak relevan / tidak dapat dipastikan";
  }

  const obfuscationText = truncate(result.protection || "Tidak Terdeteksi", 200);

  const networkIndicators = (result.indicators || []).filter((i) => i.group === "network");
  const networkText = networkIndicators.length
    ? networkIndicators.map((i) => `• ${i.label}${i.line ? ` (baris ${i.line})` : ""}`).join("\n")
    : "Tidak ada.";

  const webhookText = result.webhook
    ? `✅ Ditemukan\nURL: \`${truncate(result.webhook, 200)}\`\nStatus: ${result.webhookStatus || "Tidak dapat diperiksa"}`
    : "Tidak ada.";

  // Non-info indicators outside the network group — most actionable signals.
  const indicatorList = (result.indicators || []).filter(
    (i) => i.severity !== "info" && i.group !== "network",
  );
  const indicatorText = indicatorList.length
    ? indicatorList
        .map((i) => {
          const sev = i.severity === "critical" ? "🚨" : i.severity === "high" ? "🔴" : "🟡";
          return `${sev} ${i.label}${i.line ? ` (baris ${i.line})` : ""}`;
        })
        .join("\n")
    : "Tidak ada.";

  // Detection Reasons: always non-empty -- assessThreat()/report.js already
  // guarantee a fallback sentence, but guard here too so the embed never
  // ships a blank field.
  const reasonsText = (result.reasons || []).length
    ? result.reasons.slice(0, 6).map((r) => `• ${r}`).join("\n")
    : "• Tidak ada catatan analisis tambahan.";

  const summaryText = truncate(result.conclusion || result.summary || result.explanation || "-", 500);

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(title)
    .setDescription(result.banner || null);

  // --- Section 1: File identity ---
  embed.addFields(
    { name: "📄 Nama File", value: truncate(result.fileName, 250) || "-", inline: true },
    { name: "📦 Ukuran", value: result.fileSizeLabel, inline: true },
    { name: "⏱ Durasi Scan", value: `${result.scanTimeMs} ms`, inline: true },
    { name: "🧾 Tipe File", value: truncate(result.fileTypeLabel || "Tidak Dapat Dipastikan", 200), inline: true },
    { name: "🔤 Info Lua", value: truncate(luaInfoText, 200), inline: true },
    { name: "🧬 Obfuscator", value: obfuscationText, inline: true },
  );

  // --- Section 2: Score & verdict (full-width so it reads as a heading) ---
  embed.addFields(
    { name: "🎯 Confidence Score", value: confidenceText, inline: true },
    { name: "📈 Analysis Coverage", value: coverageText, inline: true },
    { name: "🚩 Matched Indicators", value: `${matchedCount}`, inline: true },
    { name: `${meta.emoji} Status`, value: truncate(result.statusText, 300), inline: false },
  );

  // --- Section 3: Findings ---
  embed.addFields(
    { name: "🌐 Network", value: truncate(networkText, 500), inline: false },
    { name: "🔗 Webhook", value: truncate(webhookText, 500), inline: false },
    { name: "📋 Indikator Terdeteksi", value: truncate(indicatorText, 700), inline: false },
    { name: "🔎 Alasan Deteksi", value: truncate(reasonsText, 800), inline: false },
  );

  // --- Section 4: Conclusion & recommendation ---
  embed.addFields(
    { name: "🧠 Kesimpulan", value: summaryText, inline: false },
    { name: "✅ Rekomendasi", value: truncate(result.recommendation || "-", 500), inline: false },
  );

  // Contextual notes for special file types.
  if (result.isLimitedContainer) {
    embed.addFields({
      name: "⚠️ Catatan Format",
      value: "Format container/executable ini (RAR/7z/EXE/DLL) tidak dapat diekstrak atau di-disassemble sepenuhnya. Hanya entropy dan string mentah yang diperiksa.",
    });
  }

  // For Lua bytecode: explicitly note that being compiled is not suspicious
  // on its own, so users don't misread a low-score compiled file as risky.
  const isBytecode = result.luaVersion || result.luaVariant?.toLowerCase().includes("bytecode");
  if (isBytecode && (result.level === "AMAN" || result.level === "PERLU_DICEK")) {
    embed.addFields({
      name: "ℹ️ Catatan Bytecode",
      value: "File ini adalah bytecode Lua yang dikompilasi. Analisis terbatas pada string yang dapat diekstrak dari bytecode — dikompilasi bukan berarti berbahaya.",
    });
  }

  embed
    .setFooter({
      text: "Keylogger Scanner Bot — Analisis heuristik otomatis, bukan jaminan absolut. Klik Full Preview untuk detail lengkap.",
    })
    .setTimestamp();

  return embed;
}
