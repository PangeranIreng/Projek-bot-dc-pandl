/**
 * cleaner.js — BoomBox V2 safe file cleaner.
 *
 * Yang BOLEH dihapus:
 *   - storage/cache/*      (temp audio sebelum upload)
 *   - storage/downloads/*  (file download sementara)
 *   - Expired in-memory metadata cache (via boomboxCache.js)
 *   - Orphan files (file tanpa referensi aktif)
 *   - Temporary log files di logs/ (kecuali .gitkeep)
 *
 * Yang TIDAK BOLEH disentuh:
 *   - data/*.json          (semua database)
 *   - storage/backup/*     (backup data)
 *   - config/*             (konfigurasi)
 *   - Semua field penting: premium, limit, setup, history, URL BoomBox
 *
 * Dipanggil dari setupboombox panel atau secara manual.
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, "..", "..", "..");

// Direktori yang boleh dibersihkan (isi file saja, folder tetap ada)
const SAFE_CLEAN_DIRS = [
  path.join(ROOT, "storage", "cache"),
  path.join(ROOT, "storage", "downloads"),
];

// File yang TIDAK boleh dihapus bahkan di dalam direktori bersih
const PROTECTED_FILENAMES = new Set([".gitkeep", ".gitignore"]);

// Umur minimum file sebelum dianggap orphan/aman dihapus (ms)
const MIN_AGE_MS = 5 * 60 * 1000; // 5 menit

/** @returns {{ deleted: number, skipped: number, errors: number, freedBytes: number }} */
export async function runCleaner() {
  const result = { deleted: 0, skipped: 0, errors: 0, freedBytes: 0 };
  const now    = Date.now();

  for (const dir of SAFE_CLEAN_DIRS) {
    if (!fs.existsSync(dir)) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      logger.warn(`[Cleaner] Cannot read dir ${dir}: ${e.message}`);
      result.errors++;
      continue;
    }

    for (const name of entries) {
      if (PROTECTED_FILENAMES.has(name)) {
        result.skipped++;
        continue;
      }

      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);

        // Hanya hapus file yang sudah cukup tua (bukan file sedang diproses)
        const ageMs = now - Math.max(stat.mtimeMs, stat.ctimeMs);
        if (ageMs < MIN_AGE_MS) {
          result.skipped++;
          continue;
        }

        const size = stat.isDirectory() ? 0 : stat.size;
        fs.rmSync(fullPath, { recursive: true, force: true });
        result.deleted++;
        result.freedBytes += size;
        logger.debug(`[Cleaner] Deleted: ${fullPath} (${(size / 1024).toFixed(1)} KB)`);
      } catch (e) {
        logger.warn(`[Cleaner] Failed to delete ${fullPath}: ${e.message}`);
        result.errors++;
      }
    }
  }

  // Clean temporary log files (logs/*.log, NOT .gitkeep)
  const logsDir = path.join(ROOT, "logs");
  if (fs.existsSync(logsDir)) {
    try {
      const logFiles = fs.readdirSync(logsDir);
      for (const name of logFiles) {
        if (PROTECTED_FILENAMES.has(name)) continue;
        if (!name.endsWith(".log") && !name.endsWith(".tmp")) continue;
        const fp = path.join(logsDir, name);
        try {
          const stat = fs.statSync(fp);
          // Only remove log files older than 24h
          if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) {
            const size = stat.size;
            fs.rmSync(fp, { force: true });
            result.deleted++;
            result.freedBytes += size;
          } else {
            result.skipped++;
          }
        } catch { result.errors++; }
      }
    } catch (e) {
      logger.warn(`[Cleaner] Cannot clean logs dir: ${e.message}`);
    }
  }

  logger.info(
    `[Cleaner] Done — deleted=${result.deleted}, skipped=${result.skipped}, ` +
    `errors=${result.errors}, freed=${(result.freedBytes / 1024).toFixed(1)} KB`
  );

  return result;
}

/**
 * Format cleaner result into a human-readable summary string.
 * @param {{ deleted: number, skipped: number, errors: number, freedBytes: number }} result
 */
export function formatCleanerResult(result) {
  const freed = result.freedBytes >= 1024 * 1024
    ? `${(result.freedBytes / 1024 / 1024).toFixed(2)} MB`
    : `${(result.freedBytes / 1024).toFixed(1)} KB`;
  return (
    `🗑️ **Dihapus**: ${result.deleted} file\n` +
    `⏭️ **Dilewati**: ${result.skipped} file\n` +
    `⚠️ **Error**: ${result.errors}\n` +
    `💾 **Dibebaskan**: ${freed}`
  );
}
