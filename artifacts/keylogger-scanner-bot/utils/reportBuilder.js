/**
 * utils/reportBuilder.js — Builds a plain-text analysis report for the
 * "Download Preview" button. The file is delivered as a .txt attachment
 * containing the full scan result in a human-readable format.
 */

import { BAND_META } from "../scanner/riskScore.js";

function line(label, value) {
  return `${label.padEnd(24)} ${value ?? "-"}`;
}

function sectionHeader(title) {
  const bar = "─".repeat(60);
  return `\n${bar}\n${title}\n${bar}`;
}

/**
 * Build a plain-text report from a scan result.
 * @param {object} result  A scan result object from scanFile()
 * @returns {string}
 */
export function buildTextReport(result) {
  const meta = BAND_META[result.level] || BAND_META.UNKNOWN;
  const now  = new Date().toISOString();

  const lines = [];

  lines.push("Keylogger Scanner Bot — Analysis Report");
  lines.push(`Generated: ${now}`);
  lines.push("=".repeat(60));

  // ── File Identity ─────────────────────────────────────────────────────────
  lines.push(sectionHeader("FILE IDENTITY"));
  lines.push(line("File Name:",      result.fileName));
  lines.push(line("File Size:",      result.fileSizeLabel));
  lines.push(line("File Type:",      result.fileTypeLabel));
  lines.push(line("Lua Info:",       result.luaVersion
    ? `${result.luaVersion} (bytecode)`
    : result.luaVersionSource
      ? `${result.luaVersionSource} (source)`
      : result.luaVariant || "Not applicable"));
  lines.push(line("Obfuscator:",     result.protection));
  lines.push(line("Scan Time:",      `${result.scanTimeMs ?? 0} ms`));

  // ── Verdict ───────────────────────────────────────────────────────────────
  lines.push(sectionHeader("VERDICT"));
  lines.push(line("Level:",            `${meta.emoji} ${meta.label}`));
  lines.push(line("Confidence Score:", result.confidence != null ? `${result.confidence}/100` : "N/A"));
  lines.push(line("Analysis Coverage:", `${result.analysisCoveragePercent ?? 0}%`));
  lines.push(line("Matched Indicators:", `${result.matchedIndicatorCount ?? 0}`));
  lines.push("");
  lines.push("Status:");
  lines.push(`  ${result.statusText || "-"}`);

  // ── Risk Score Breakdown ──────────────────────────────────────────────────
  if (Array.isArray(result.riskBreakdown) && result.riskBreakdown.length > 0) {
    lines.push(sectionHeader("RISK SCORE BREAKDOWN"));
    for (const b of result.riskBreakdown) {
      lines.push(`  +${String(b.delta).padStart(3)}  ${b.label}`);
    }
    lines.push(`  ────────────────────────`);
    lines.push(`  Total: ${result.confidence ?? "N/A"}/100`);
  }

  // ── All Indicators ────────────────────────────────────────────────────────
  lines.push(sectionHeader("INDICATORS DETECTED"));
  const indicators = result.indicators || [];
  if (indicators.length === 0) {
    lines.push("  None detected.");
  } else {
    for (const ind of indicators) {
      const sev  = `[${(ind.severity || "info").toUpperCase().padEnd(8)}]`;
      const cnt  = ind.count && ind.count > 1 ? ` x${ind.count}` : "";
      const lineN = ind.line ? ` (line ${ind.line})` : "";
      lines.push(`  ${sev}${cnt} ${ind.label}${lineN}`);
      if (ind.samples && ind.samples.length > 0) {
        for (const s of ind.samples.slice(0, 3)) {
          lines.push(`         Sample: ${String(s).slice(0, 120)}`);
        }
      }
    }
  }

  // ── Detection Reasons ─────────────────────────────────────────────────────
  lines.push(sectionHeader("DETECTION REASONS"));
  const reasons = result.reasons || [];
  if (reasons.length === 0) {
    lines.push("  No additional notes.");
  } else {
    for (const r of reasons) {
      lines.push(`  • ${r}`);
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────────────
  lines.push(sectionHeader("WEBHOOK"));
  if (result.webhook) {
    lines.push(`  URL:    ${result.webhook}`);
    lines.push(`  Status: ${result.webhookStatus || "Not checked"}`);
  } else {
    lines.push("  None found.");
  }

  // ── Decode Layers ─────────────────────────────────────────────────────────
  const decodeLayers = result.decodeLayers || result.recovery?.layers || [];
  if (decodeLayers.length > 0) {
    lines.push(sectionHeader("DECODE LAYERS"));
    for (const l of decodeLayers) {
      const status = l.opened ? "OPENED" : "FAILED";
      lines.push(`  [${status}] Layer ${l.index}: ${l.method || "Unknown"}${l.reason ? ` — ${l.reason}` : ""}`);
    }
  }

  // ── Methods Attempted ─────────────────────────────────────────────────────
  const methods = result.attemptedMethods || [];
  if (methods.length > 0) {
    lines.push(sectionHeader("METHODS ATTEMPTED"));
    for (const m of [...new Set(methods)]) {
      lines.push(`  ✔ ${m}`);
    }
  }

  // ── Conclusion ────────────────────────────────────────────────────────────
  lines.push(sectionHeader("CONCLUSION"));
  lines.push(result.conclusion || result.summary || result.explanation || "No conclusion available.");

  lines.push(sectionHeader("RECOMMENDATION"));
  lines.push(result.recommendation || "None.");

  lines.push("\n" + "=".repeat(60));
  lines.push("End of report. This is an automated analysis — not an absolute guarantee.");
  lines.push("Always verify suspicious files manually before use.");

  return lines.join("\n");
}
