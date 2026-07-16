/**
 * features/database/backup.js — Logika Backup, Storage, dan Smart Clean.
 *
 * Backup:
 *   - Membuat ZIP berisi database, config, dan data penting lainnya.
 *   - TIDAK menyertakan: node_modules, cache, temp, folder kosong.
 *   - Bisa didownload dari Discord atau diupload ke GitHub Releases.
 *
 * Storage:
 *   - Menghitung ukuran tiap bagian penting project.
 *
 * Smart Clean:
 *   - Memindai folder project dan mengkategorikan file.
 *   - TIDAK langsung menghapus — harus konfirmasi admin dulu.
 *   - Kategori: 🟢 Aman, 🟡 Perlu Ditinjau, 🔴 File Penting.
 */

import fs      from "node:fs";
import path    from "node:path";
import os      from "node:os";
import AdmZip  from "adm-zip";
import { fileURLToPath } from "node:url";
import { logger } from "../../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.join(__dirname, "..", "..", "..");

// Folder sementara untuk menyimpan file backup sebelum dikirim ke Discord
const BACKUP_TMP_DIR = path.join(os.tmpdir(), "bot-backups");

/** Ukuran file dalam format yang mudah dibaca (KB / MB). */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Hitung total ukuran sebuah direktori secara rekursif.
 * @param {string} dirPath
 * @returns {number} Total ukuran dalam bytes
 */
function getDirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dirPath, item.name);
      try {
        if (item.isDirectory()) total += getDirSize(full);
        else total += fs.statSync(full).size;
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip unreadable dir */ }
  return total;
}

/**
 * Tambahkan folder ke ZIP jika ada, dengan fallback graceful jika tidak ada.
 * @param {AdmZip} zip
 * @param {string} localPath  Path absolut folder
 * @param {string} zipPath    Path di dalam ZIP
 */
function addFolderIfExists(zip, localPath, zipPath) {
  if (!fs.existsSync(localPath)) return;
  try {
    zip.addLocalFolder(localPath, zipPath);
  } catch (err) {
    logger.warn(`[Database/Backup] Tidak bisa menambahkan folder ${localPath}: ${err.message}`);
  }
}

/**
 * Tambahkan file ke ZIP jika ada.
 * @param {AdmZip} zip
 * @param {string} localFile
 * @param {string} zipDir
 */
function addFileIfExists(zip, localFile, zipDir) {
  if (!fs.existsSync(localFile)) return;
  try {
    zip.addLocalFile(localFile, zipDir);
  } catch (err) {
    logger.warn(`[Database/Backup] Tidak bisa menambahkan file ${localFile}: ${err.message}`);
  }
}

// ── Tabel backup ZIP ──────────────────────────────────────────────────────────
// Menyimpan ZIP temporary agar bisa di-upload setelah dibuat.
// Key: tmpId (string), Value: { filePath, fileName, size, createdAt }
const _backupTable = new Map();

/**
 * Buat file backup ZIP.
 * @returns {Promise<{ tmpId: string, filePath: string, fileName: string, size: number, sizeStr: string }>}
 */
export async function createBackupZip() {
  // Pastikan folder temp ada
  if (!fs.existsSync(BACKUP_TMP_DIR)) {
    fs.mkdirSync(BACKUP_TMP_DIR, { recursive: true });
  }

  const now      = new Date();
  const stamp    = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `backup-${stamp}.zip`;
  const filePath = path.join(BACKUP_TMP_DIR, fileName);

  const zip = new AdmZip();

  // ── Database (data/*.json) ────────────────────────────────────────────────
  addFolderIfExists(zip, path.join(ROOT_DIR, "data"), "database");

  // ── Config ────────────────────────────────────────────────────────────────
  addFolderIfExists(zip, path.join(ROOT_DIR, "config"), "config");

  // ── Assets ────────────────────────────────────────────────────────────────
  addFolderIfExists(zip, path.join(ROOT_DIR, "assets"), "assets");

  // ── Logs ──────────────────────────────────────────────────────────────────
  addFolderIfExists(zip, path.join(ROOT_DIR, "logs"), "logs");

  // ── Session ───────────────────────────────────────────────────────────────
  addFolderIfExists(zip, path.join(ROOT_DIR, "session"), "session");

  // ── Plugins ───────────────────────────────────────────────────────────────
  addFolderIfExists(zip, path.join(ROOT_DIR, "plugins"), "plugins");

  // ── Custom Commands ───────────────────────────────────────────────────────
  addFolderIfExists(zip, path.join(ROOT_DIR, "custom-commands"), "custom-commands");

  // ── Root config files ─────────────────────────────────────────────────────
  addFileIfExists(zip, path.join(ROOT_DIR, "package.json"), "");

  // ── backup-info.json ──────────────────────────────────────────────────────
  const info = {
    createdAt:   now.toISOString(),
    version:     _readPackageVersion(),
    contents:    ["database", "config", "assets", "logs", "session", "plugins", "custom-commands"],
    excludes:    ["node_modules", "npm cache", "temp", "cache sementara", "folder kosong", "file sampah"],
    note:        "Backup dibuat otomatis oleh Pangeran Assistant AI",
  };
  zip.addFile("backup-info.json", Buffer.from(JSON.stringify(info, null, 2), "utf8"));

  // Tulis ke disk
  zip.writeZip(filePath);

  const stat    = fs.statSync(filePath);
  const tmpId   = `bkp-${Date.now()}`;
  const entry   = { filePath, fileName, size: stat.size, sizeStr: formatBytes(stat.size), createdAt: now.toISOString() };
  _backupTable.set(tmpId, entry);

  // Hapus file temp setelah 30 menit agar tidak menumpuk
  setTimeout(() => {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    _backupTable.delete(tmpId);
  }, 30 * 60 * 1000);

  logger.info(`[Database/Backup] Backup dibuat: ${fileName} (${entry.sizeStr})`);
  return { tmpId, ...entry };
}

/**
 * Ambil info backup berdasarkan tmpId.
 * @param {string} tmpId
 * @returns {{ filePath: string, fileName: string, size: number, sizeStr: string }|null}
 */
export function getBackupEntry(tmpId) {
  return _backupTable.get(tmpId) ?? null;
}

/**
 * Upload backup ke GitHub Releases menggunakan token dari env.
 * Membutuhkan env vars: GITHUB_TOKEN dan GITHUB_REPO ("owner/repo").
 * @param {string} tmpId
 * @returns {Promise<{ url: string }>}
 */
export async function uploadBackupToGitHub(tmpId) {
  const entry = getBackupEntry(tmpId);
  if (!entry) throw new Error("File backup tidak ditemukan atau sudah kedaluwarsa.");

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO || databaseDB_getRepo();
  if (!token) throw new Error("GITHUB_TOKEN belum dikonfigurasi. Tambahkan ke Replit Secrets.");
  if (!repo)  throw new Error("GITHUB_REPO belum dikonfigurasi. Format: owner/repo");

  // 1. Buat GitHub Release baru
  const releaseName = `Backup ${new Date(entry.createdAt).toLocaleDateString("id-ID")}`;
  const releaseRes  = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent":   "PangeranAssistantBot",
    },
    body: JSON.stringify({
      tag_name:   `backup-${Date.now()}`,
      name:        releaseName,
      body:        `Backup otomatis oleh Pangeran Assistant AI\nUkuran: ${entry.sizeStr}`,
      draft:       false,
      prerelease:  true,
    }),
  });

  if (!releaseRes.ok) {
    const txt = await releaseRes.text().catch(() => "");
    throw new Error(`GitHub API error saat membuat release: ${releaseRes.status} — ${txt.slice(0, 200)}`);
  }

  const release = await releaseRes.json();

  // 2. Upload ZIP sebagai release asset
  const fileData = fs.readFileSync(entry.filePath);
  const uploadUrl = release.upload_url.replace(/\{.*\}/, `?name=${encodeURIComponent(entry.fileName)}`);

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/zip",
      "User-Agent":   "PangeranAssistantBot",
    },
    body: fileData,
  });

  if (!uploadRes.ok) {
    const txt = await uploadRes.text().catch(() => "");
    throw new Error(`GitHub API error saat upload asset: ${uploadRes.status} — ${txt.slice(0, 200)}`);
  }

  const asset = await uploadRes.json();
  return { url: asset.browser_download_url ?? release.html_url };
}

/** Ambil GITHUB_REPO dari databaseDB (lazy import untuk hindari circular). */
function databaseDB_getRepo() {
  try {
    // Dynamic import tidak bisa dipakai di non-async context, gunakan env var saja
    return null;
  } catch { return null; }
}

// ── Storage Stats ─────────────────────────────────────────────────────────────

/**
 * Hitung ukuran berbagai bagian project.
 * @returns {{ database: number, cache: number, temp: number, backup: number, assets: number, logs: number, total: number, strings: Object }}
 */
export function getStorageStats() {
  const db     = getDirSize(path.join(ROOT_DIR, "data"));
  const cache  = getDirSize(path.join(ROOT_DIR, "cache")) + getDirSize(path.join(ROOT_DIR, ".cache"));
  const tmp    = getDirSize(path.join(ROOT_DIR, "temp"))  + getDirSize(path.join(ROOT_DIR, "tmp"))  + getDirSize(BACKUP_TMP_DIR);
  const backup = getDirSize(path.join(ROOT_DIR, "backup"));
  const assets = getDirSize(path.join(ROOT_DIR, "assets"));
  const logs   = getDirSize(path.join(ROOT_DIR, "logs"));
  const src    = getDirSize(path.join(ROOT_DIR, "src"));
  const conf   = getDirSize(path.join(ROOT_DIR, "config"));
  const total  = db + cache + tmp + backup + assets + logs + src + conf;

  // Coba baca total disk usage dari /proc atau fallback
  let diskTotal = 0;
  let diskFree  = 0;
  try {
    const stat = fs.statfsSync ? fs.statfsSync(ROOT_DIR) : null;
    if (stat) {
      diskTotal = stat.bsize * stat.blocks;
      diskFree  = stat.bsize * stat.bfree;
    }
  } catch { /* fs.statfsSync tidak tersedia di semua Node versi */ }

  return {
    database: db,
    cache,
    temp:     tmp,
    backup,
    assets,
    logs,
    source:   src,
    total,
    diskTotal,
    diskFree,
    strings: {
      database: formatBytes(db),
      cache:    formatBytes(cache),
      temp:     formatBytes(tmp),
      backup:   formatBytes(backup),
      assets:   formatBytes(assets),
      logs:     formatBytes(logs),
      source:   formatBytes(src),
      total:    formatBytes(total),
      diskTotal: diskTotal ? formatBytes(diskTotal) : "N/A",
      diskFree:  diskFree  ? formatBytes(diskFree)  : "N/A",
    },
  };
}

// ── Smart Clean ───────────────────────────────────────────────────────────────

// Pola path yang AMAN untuk dihapus
const SAFE_PATTERNS = [
  /^cache\//i,
  /\/__pycache__\//,
  /\/\.cache\//,
  /\/temp\//i,
  /\/tmp\//i,
  /\.tmp$/i,
  /\.bak$/i,
  /\/src\/bin\/yt-dlp/i,       // binary yt-dlp (bisa didownload ulang)
  /\/src\/bin\/ffmpeg/i,        // binary ffmpeg (jika ada)
  /node_modules\/\.cache\//,
];

// Pola path yang PERLU DITINJAU (mungkin bisa dihapus, tapi hati-hati)
const REVIEW_PATTERNS = [
  /\/logs?\/.*\.log$/i,
  /\/backup\/.*\.zip$/i,
  /bot-backups\/.*\.zip$/i,
  /\/uploads?\//i,
  /\/downloads?\//i,
];

// Pola path yang TIDAK BOLEH dihapus sama sekali
const PROTECTED_PATTERNS = [
  /^data\//,
  /^config\//,
  /^src\//,
  /^\.env/,
  /package\.json$/,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /node_modules\//,
  /^\.git\//,
  /assets\//,
  /plugins\//,
];

// Folder yang di-skip sepenuhnya saat scan
const SKIP_DIRS = new Set(["node_modules", ".git", ".pnpm-store"]);

/**
 * Rekursif walk directory, kembalikan semua file/folder dengan path relatif.
 * @param {string} dir
 * @param {string} [base]
 * @returns {{ rel: string, abs: string, isDir: boolean, size: number, mtime: Date }[]}
 */
function walkDir(dir, base = ROOT_DIR) {
  const results = [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }

  for (const item of items) {
    if (SKIP_DIRS.has(item.name)) continue;

    const abs = path.join(dir, item.name);
    const rel = path.relative(base, abs).replace(/\\/g, "/");

    if (item.isDirectory()) {
      // Cek apakah folder kosong
      let children;
      try { children = fs.readdirSync(abs); } catch { children = []; }
      if (children.length === 0) {
        results.push({ rel: rel + "/", abs, isDir: true, size: 0, mtime: new Date() });
      } else {
        results.push(...walkDir(abs, base));
      }
    } else {
      let stat;
      try { stat = fs.statSync(abs); } catch { continue; }
      results.push({ rel, abs, isDir: false, size: stat.size, mtime: stat.mtime });
    }
  }
  return results;
}

/**
 * Jalankan Smart Clean — scan folder project, kategorikan file.
 * TIDAK menghapus apapun — hanya analisa.
 *
 * @returns {{
 *   safe:    { rel: string, abs: string, size: number, reason: string, isDir: boolean }[],
 *   review:  { rel: string, abs: string, size: number, reason: string, isDir: boolean }[],
 *   protected: { rel: string, abs: string, size: number, reason: string, isDir: boolean }[],
 *   totalSafeSize: number,
 *   totalSafeSizeStr: string,
 *   scannedAt: string,
 * }}
 */
export function runSmartClean() {
  const now   = new Date();
  const files = walkDir(ROOT_DIR, ROOT_DIR);

  const safe      = [];
  const review    = [];
  const protected_ = [];

  for (const file of files) {
    const rel = file.rel;

    // 1. Cek apakah dilindungi
    const isProtected = PROTECTED_PATTERNS.some((p) => p.test(rel));
    if (isProtected) {
      protected_.push({ ...file, reason: _protectedReason(rel) });
      continue;
    }

    // 2. Cek apakah aman
    const isSafe = SAFE_PATTERNS.some((p) => p.test(rel));
    if (isSafe) {
      safe.push({ ...file, reason: _safeReason(rel) });
      continue;
    }

    // 3. Cek apakah perlu ditinjau
    const isReview = REVIEW_PATTERNS.some((p) => p.test(rel));
    if (isReview) {
      // Log lama (> 30 hari) → aman dihapus
      const isOldLog = /\.log$/i.test(rel) && (now - file.mtime) > 30 * 24 * 60 * 60 * 1000;
      if (isOldLog) {
        safe.push({ ...file, reason: "File log lebih dari 30 hari." });
      } else {
        review.push({ ...file, reason: _reviewReason(rel, file.mtime) });
      }
      continue;
    }

    // 4. Folder kosong → aman
    if (file.isDir) {
      safe.push({ ...file, reason: "Folder kosong — tidak berisi file apapun." });
    }
  }

  const totalSafeSize = safe.reduce((s, f) => s + f.size, 0);

  return {
    safe,
    review,
    protected: protected_,
    totalSafeSize,
    totalSafeSizeStr: formatBytes(totalSafeSize),
    scannedAt: now.toISOString(),
  };
}

function _safeReason(rel) {
  if (/^cache\//i.test(rel) || /\/\.cache\//i.test(rel)) return "Cache lama — dapat dibuat ulang otomatis.";
  if (/^temp\//i.test(rel) || /^tmp\//i.test(rel))       return "File sementara — tidak diperlukan lagi.";
  if (/\.tmp$/i.test(rel))                               return "File temporary — dapat dihapus aman.";
  if (/\.bak$/i.test(rel))                               return "File backup lama — duplikat tidak diperlukan.";
  if (/\/src\/bin\//i.test(rel))                         return "Binary yt-dlp — akan didownload ulang otomatis saat dibutuhkan.";
  return "Teridentifikasi sebagai file sementara atau cache yang aman dihapus.";
}

function _reviewReason(rel, mtime) {
  if (/\.log$/i.test(rel)) {
    const days = Math.floor((Date.now() - mtime) / (24 * 60 * 60 * 1000));
    return `File log berusia ${days} hari. Periksa sebelum dihapus.`;
  }
  if (/\.zip$/i.test(rel)) return "File backup ZIP. Pastikan sudah tidak diperlukan.";
  if (/\/uploads?\//i.test(rel)) return "File upload. Periksa apakah masih digunakan.";
  if (/\/downloads?\//i.test(rel)) return "File download. Periksa apakah masih digunakan.";
  return "File tidak dikenali sebagai aman atau penting. Periksa sebelum menghapus.";
}

function _protectedReason(rel) {
  if (/^data\//i.test(rel)) return "File database — TIDAK BOLEH dihapus.";
  if (/^config\//i.test(rel)) return "File konfigurasi sistem — TIDAK BOLEH dihapus.";
  if (/^src\//i.test(rel)) return "Source code bot — TIDAK BOLEH dihapus.";
  if (/\.env/i.test(rel)) return "File environment/secrets — TIDAK BOLEH dihapus.";
  if (/package/i.test(rel)) return "File package manager — TIDAK BOLEH dihapus.";
  if (/node_modules/i.test(rel)) return "Dependencies bot — TIDAK BOLEH dihapus.";
  if (/assets/i.test(rel)) return "File aset — lindungi dari penghapusan tidak sengaja.";
  return "File penting sistem — TIDAK BOLEH dihapus.";
}

/**
 * Eksekusi penghapusan file yang sudah dikonfirmasi admin.
 * Hanya menghapus file dalam kategori 🟢 Aman.
 *
 * @param {{ abs: string, isDir: boolean }[]} toDelete  Daftar file dari kategori safe
 * @returns {{ deleted: number, freed: number, freedStr: string, errors: string[] }}
 */
export function executeClean(toDelete) {
  let deleted = 0;
  let freed   = 0;
  const errors = [];

  for (const item of toDelete) {
    // Double-check: pastikan tidak ada pola protected
    const rel = path.relative(ROOT_DIR, item.abs).replace(/\\/g, "/");
    const isProtected = PROTECTED_PATTERNS.some((p) => p.test(rel));
    if (isProtected) {
      errors.push(`SKIP (protected): ${rel}`);
      continue;
    }

    try {
      if (item.isDir) {
        fs.rmSync(item.abs, { recursive: true, force: true });
      } else {
        const size = fs.existsSync(item.abs) ? fs.statSync(item.abs).size : 0;
        fs.unlinkSync(item.abs);
        freed += size;
      }
      deleted++;
    } catch (err) {
      errors.push(`Gagal hapus ${rel}: ${err.message}`);
    }
  }

  return { deleted, freed, freedStr: formatBytes(freed), errors };
}

/** Baca versi dari package.json. */
function _readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
    return pkg.version ?? "2.0.0";
  } catch {
    return "2.0.0";
  }
}

export { formatBytes };
