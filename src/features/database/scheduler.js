/**
 * features/database/scheduler.js — Auto Backup Scheduler.
 *
 * Menjalankan backup otomatis sesuai jadwal yang dikonfigurasi admin.
 * Jadwal: "6h" | "12h" | "daily" | "weekly"
 *
 * Cara kerja:
 *   - startAutoBackupScheduler(client) dipanggil sekali di ready.js
 *   - Setiap 5 menit, cek apakah sudah waktunya backup
 *   - Jika ya: buat ZIP → simpan ke DB → upload GitHub jika dikonfigurasi
 */

import { databaseDB }                         from "../../database/databaseDB.js";
import { createBackupZip, uploadBackupToGitHub } from "./backup.js";
import { consoleLog }                         from "./console.js";
import { logger }                             from "../../utils/logger.js";

/** Interval dalam milidetik untuk setiap opsi jadwal. */
export const SCHEDULE_INTERVALS = {
  "6h":     6  * 60 * 60 * 1000,
  "12h":    12 * 60 * 60 * 1000,
  "daily":  24 * 60 * 60 * 1000,
  "weekly": 7  * 24 * 60 * 60 * 1000,
};

export const SCHEDULE_LABELS = {
  "6h":     "Setiap 6 Jam",
  "12h":    "Setiap 12 Jam",
  "daily":  "Setiap Hari",
  "weekly": "Setiap Minggu",
};

let _timer  = null;
let _client = null;

/**
 * Mulai scheduler. Aman dipanggil berkali-kali — hanya ada satu timer aktif.
 * @param {import("discord.js").Client} client
 */
export function startAutoBackupScheduler(client) {
  _client = client;
  if (_timer) clearInterval(_timer);
  // Cek setiap 5 menit
  _timer = setInterval(_checkAndRun, 5 * 60 * 1000);
  logger.info("[Database/Scheduler] Auto backup scheduler aktif (cek setiap 5 menit)");
}

/** Hentikan scheduler. */
export function stopAutoBackupScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * Hitung kapan backup berikutnya dijadwalkan.
 * @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup
 * @returns {string|null} ISO string atau null jika tidak terjadwal
 */
export function getNextBackupAt(setup) {
  if (!setup.autoBackup || !setup.backupSchedule) return null;
  const interval = SCHEDULE_INTERVALS[setup.backupSchedule];
  if (!interval) return null;
  const lastAt = setup.lastBackup?.at ? new Date(setup.lastBackup.at).getTime() : 0;
  return new Date(lastAt + interval).toISOString();
}

/** Format ISO timestamp ke tampilan lokal yang ringkas. */
export function formatScheduleTime(isoStr) {
  if (!isoStr) return "—";
  try {
    return new Date(isoStr).toLocaleString("id-ID", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return isoStr; }
}

/** Cek dan jalankan backup jika sudah waktunya. */
async function _checkAndRun() {
  try {
    const setup = databaseDB.get();
    if (!setup.autoBackup || !setup.backupSchedule) return;

    const interval = SCHEDULE_INTERVALS[setup.backupSchedule];
    if (!interval) return;

    const lastAt = setup.lastBackup?.at ? new Date(setup.lastBackup.at).getTime() : 0;
    const nextAt = lastAt + interval;
    if (Date.now() < nextAt) return; // belum waktunya

    logger.info(`[Database/Scheduler] Menjalankan auto backup (jadwal: ${setup.backupSchedule})`);

    const result = await createBackupZip();
    databaseDB.recordBackup(result.fileName, result.sizeStr, result.createdAt);
    consoleLog("auto_backup", "🔄 Auto Backup", `${result.fileName} (${result.sizeStr})`).catch(() => {});

    // Auto upload ke GitHub jika dikonfigurasi
    const hasGitHub = !!(setup.github?.repo && (setup.github?.token || process.env.GITHUB_TOKEN));
    if (hasGitHub) {
      try {
        const up = await uploadBackupToGitHub(result.tmpId);
        consoleLog("auto_backup_upload", "☁️ Auto Upload", up.url).catch(() => {});
        logger.info(`[Database/Scheduler] Auto upload selesai: ${up.url}`);
      } catch (uploadErr) {
        logger.warn(`[Database/Scheduler] Auto upload gagal (non-fatal): ${uploadErr.message}`);
        consoleLog("auto_backup_warn", "⚠️ Upload Gagal", uploadErr.message).catch(() => {});
      }
    }
  } catch (err) {
    logger.error(`[Database/Scheduler] Auto backup gagal: ${err.message}`);
  }
}
