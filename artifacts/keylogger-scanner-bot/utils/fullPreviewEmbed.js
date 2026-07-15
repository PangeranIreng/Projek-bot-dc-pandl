/**
 * utils/fullPreviewEmbed.js — Builds the detailed "Full Preview" embed
 * shown ephemerally when a user clicks the "Full Preview" button on a
 * scan result. Includes the complete risk score breakdown, all matched
 * indicators (including info-level ones hidden from the main embed),
 * decode layers opened, AST stats, entropy signal, and the full
 * attempted-methods checklist.
 */

import { EmbedBuilder } from "discord.js";
import { BAND_META } from "../scanner/riskScore.js";
import { truncate } from "./fileUtils.js";

const MAX_FIELD_LEN = 1024;

function trunc(str, max = MAX_FIELD_LEN) {
  return truncate(String(str ?? ""), max);
}

function formatSeverity(sev) {
  switch (sev) {
    case "critical": return "🚨 CRITICAL";
    case "high":     return "🔴 HIGH";
    case "medium":   return "🟡 MEDIUM";
    case "low":      return "🔵 LOW";
    case "info":     return "ℹ️ INFO";
    default:         return String(sev).toUpperCase();
  }
}

/**
 * Build the Full Preview ephemeral embed for a scan result.
 * @param {object} result  A scan result object from scanFile()
 * @returns {import("discord.js").EmbedBuilder}
 */
export function buildFullPreviewEmbed(result) {
  const meta = BAND_META[result.level] || BAND_META.UNKNOWN;

  const titleScore = result.confidence != null ? ` [${result.confidence}/100]` : "";
  const title = `${meta.emoji} Full Preview — ${meta.label}${titleScore}`;

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(title)
    .setDescription(trunc(result.banner || null, 500))
    .setTimestamp()
    .setFooter({ text: "Keylogger Scanner Bot — Full Preview (ephemeral)" });

  // ── Section 1: Identity ───────────────────────────────────────────────────
  embed.addFields(
    { name: "📄 File",      value: trunc(result.fileName, 200),              inline: true },
    { name: "📦 Size",      value: trunc(result.fileSizeLabel, 100),          inline: true },
    { name: "⏱ Scan Time",  value: `${result.scanTimeMs ?? 0} ms`,           inline: true },
    { name: "🧾 Type",      value: trunc(result.fileTypeLabel, 200),          inline: true },
    { name: "🔤 Lua Info",  value: trunc(result.luaVersion
        ? `${result.luaVersion} (bytecode)`
        : result.luaVersionSource
          ? `${result.luaVersionSource} (source)`
          : result.luaVariant || "Tidak relevan", 200),                       inline: true },
    { name: "🧬 Obfuscator", value: trunc(result.protection, 200),            inline: true },
  );

  // ── Section 2: Score ──────────────────────────────────────────────────────
  const scoreText = result.confidence != null ? `${result.confidence}/100` : "Tidak dapat dihitung";
  const coverageText = `${result.analysisCoveragePercent ?? 0}%`;
  embed.addFields(
    { name: "🎯 Confidence Score",  value: scoreText,   inline: true },
    { name: "📈 Analysis Coverage", value: coverageText, inline: true },
    { name: "🚩 Indicators",        value: `${result.matchedIndicatorCount ?? 0}`, inline: true },
  );

  // ── Section 3: Risk score breakdown ───────────────────────────────────────
  if (Array.isArray(result.riskBreakdown) && result.riskBreakdown.length > 0) {
    const bkdLines = result.riskBreakdown
      .slice(0, 20)
      .map((b) => `+${b.delta} — ${b.label}`)
      .join("\n");
    embed.addFields({ name: "📊 Risk Score Breakdown", value: trunc("```\n" + bkdLines + "\n```", MAX_FIELD_LEN), inline: false });
  }

  // ── Section 4: All indicators (including info) ────────────────────────────
  const indicators = result.indicators || [];
  if (indicators.length > 0) {
    const indicLines = indicators
      .slice(0, 30)
      .map((i) => {
        const sev  = formatSeverity(i.severity);
        const line = i.line ? ` (baris ${i.line})` : "";
        const cnt  = i.count && i.count > 1 ? ` ×${i.count}` : "";
        return `${sev}${cnt} — ${i.label}${line}`;
      })
      .join("\n");
    const overflow = indicators.length > 30 ? `\n… dan ${indicators.length - 30} lagi.` : "";
    embed.addFields({
      name:   "📋 Semua Indikator",
      value:  trunc(indicLines + overflow, MAX_FIELD_LEN),
      inline: false,
    });
  } else {
    embed.addFields({ name: "📋 Semua Indikator", value: "Tidak ada.", inline: false });
  }

  // ── Section 5: Detection reasons ─────────────────────────────────────────
  const reasonLines = (result.reasons || []).slice(0, 10).map((r) => `• ${r}`).join("\n");
  embed.addFields({
    name:   "🔎 Alasan Deteksi",
    value:  trunc(reasonLines || "• Tidak ada catatan tambahan.", MAX_FIELD_LEN),
    inline: false,
  });

  // ── Section 6: Entropy signal ─────────────────────────────────────────────
  if (result.entropySignal) {
    const e = result.entropySignal;
    embed.addFields({
      name:   "🌡️ Entropy",
      value:  trunc(`Level: ${e.level?.toUpperCase() ?? "N/A"}\nScore: ${e.score?.toFixed(3) ?? "N/A"}\n${e.note ?? ""}`, 500),
      inline: false,
    });
  }

  // ── Section 7: Decode layers ──────────────────────────────────────────────
  const decodeLayers = result.decodeLayers || result.recovery?.layers || [];
  if (decodeLayers.length > 0) {
    const layerLines = decodeLayers
      .slice(0, 10)
      .map((l) => `${l.opened ? "✔" : "✘"} [Layer ${l.index}] ${l.method || "Unknown"}${l.reason ? ` — ${l.reason}` : ""}`)
      .join("\n");
    embed.addFields({ name: "🔓 Decode Layers", value: trunc(layerLines, MAX_FIELD_LEN), inline: false });
  }

  // ── Section 8: AST info ───────────────────────────────────────────────────
  if (result.astInfo?.attempted) {
    const a = result.astInfo;
    const astText = a.parsed
      ? `Parsed — ${a.statementCount ?? "?"} statement(s)`
      : `Failed: ${a.error || "parse error"}`;
    embed.addFields({ name: "🌲 AST Analysis", value: trunc(astText, 400), inline: true });
  }

  // ── Section 9: Methods attempted ─────────────────────────────────────────
  const methods = result.attemptedMethods || [];
  if (methods.length > 0) {
    const methodLines = [...new Set(methods)].slice(0, 25).map((m) => `✔ ${m}`).join("\n");
    embed.addFields({ name: "🔬 Metode Digunakan", value: trunc(methodLines, MAX_FIELD_LEN), inline: false });
  }

  // ── Section 10: Conclusion ────────────────────────────────────────────────
  embed.addFields(
    { name: "🧠 Kesimpulan",  value: trunc(result.conclusion || result.summary || "-", 800), inline: false },
    { name: "✅ Rekomendasi", value: trunc(result.recommendation || "-", 500),               inline: false },
  );

  return embed;
}
