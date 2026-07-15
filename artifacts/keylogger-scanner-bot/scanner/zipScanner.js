import AdmZip from "adm-zip";
import { config } from "../config/config.js";
import { getExtension } from "../utils/fileUtils.js";

/**
 * Extract a zip buffer and return the readable entries within the size/count
 * guard rails. Never throws -- a corrupt/unreadable zip is reported back as
 * `error` instead of crashing the caller.
 * @param {Buffer} buffer
 */
export function extractZipEntries(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    return { ok: false, error: `ZIP tidak dapat dibuka: ${err.message}`, entries: [] };
  }

  let rawEntries;
  try {
    rawEntries = zip.getEntries();
  } catch (err) {
    return { ok: false, error: `ZIP rusak atau tidak valid: ${err.message}`, entries: [] };
  }

  if (!rawEntries || rawEntries.length === 0) {
    return { ok: false, error: "ZIP kosong atau tidak berisi file.", entries: [] };
  }

  const entries = [];
  let totalBytes = 0;
  let skippedForSize = 0;
  let skippedForCount = 0;

  for (const entry of rawEntries) {
    if (entry.isDirectory) continue;

    if (entries.length >= config.maxZipEntries) {
      skippedForCount += 1;
      continue;
    }

    const declaredSize = entry.header.size || 0;
    if (declaredSize > config.maxEntrySizeBytes) {
      skippedForSize += 1;
      continue;
    }
    if (totalBytes + declaredSize > config.maxTotalScanBytes) {
      skippedForSize += 1;
      continue;
    }

    let data;
    try {
      data = entry.getData();
    } catch (err) {
      // Individually corrupt entry (e.g. bad CRC) -- skip it, but keep
      // scanning the rest of the archive.
      entries.push({
        name: entry.entryName,
        extension: getExtension(entry.entryName),
        buffer: null,
        error: `Gagal membaca entri: ${err.message}`,
      });
      continue;
    }

    totalBytes += data.length;
    entries.push({
      name: entry.entryName,
      extension: getExtension(entry.entryName),
      buffer: data,
      error: null,
    });
  }

  return {
    ok: true,
    error: null,
    entries,
    skippedForSize,
    skippedForCount,
    totalEntries: rawEntries.filter((e) => !e.isDirectory).length,
  };
}
