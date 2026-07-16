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
import { logger }     from "../../utils/logger.js";
import { databaseDB } from "../../database/databaseDB.js";

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

// ── Tabel restore token ───────────────────────────────────────────────────────
// Maps a short opaque token → full GitHub asset download URL.
// Tokens expire after 30 minutes to avoid unbounded memory growth.
const _restoreTokens = new Map();
const RESTORE_TOKEN_TTL = 30 * 60 * 1000;

/**
 * Store a GitHub asset download URL and return a short token safe for Discord customId.
 * @param {string} downloadUrl
 * @returns {string} token (alphanumeric, ≤20 chars)
 */
export function storeRestoreToken(downloadUrl) {
  const token = `rst${Date.now().toString(36)}`;
  _restoreTokens.set(token, { url: downloadUrl, at: Date.now() });
  // Evict expired entries
  const cutoff = Date.now() - RESTORE_TOKEN_TTL;
  for (const [k, v] of _restoreTokens) {
    if (v.at < cutoff) _restoreTokens.delete(k);
  }
  return token;
}

/**
 * Look up a restore URL by token.  Returns null if not found or expired.
 * @param {string} token
 * @returns {string|null}
 */
export function getRestoreUrl(token) {
  const entry = _restoreTokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.at > RESTORE_TOKEN_TTL) { _restoreTokens.delete(token); return null; }
  return entry.url;
}

/**
 * Folder/file yang DILEWATI saat membuat backup.
 * Backup mengambil langsung dari folder project yang sedang berjalan —
 * bukan dari GitHub, bukan dari cache, bukan dari backup sebelumnya.
 */
const BACKUP_SKIP_DIRS = new Set([
  "node_modules",   // dependencies — bisa diinstall ulang via pnpm install
  ".git",           // git history — tidak diperlukan untuk restore
  ".cache",         // cache Replit/Node
  ".local",         // skill/agent Replit, bukan bagian project
  ".agents",        // memory agent Replit, bukan bagian project
  "bin",            // binary yt-dlp — didownload ulang otomatis saat dijalankan
]);

/**
 * Path relatif root yang DILEWATI saat scan (exact match prefix).
 * Menghindari memasukkan ZIP backup yang sedang dibuat ke dalam dirinya sendiri.
 */
function _isSkippedPath(relPath) {
  // Lewati temp folder backup itu sendiri agar tidak rekursif
  if (path.resolve(ROOT_DIR, relPath).startsWith(BACKUP_TMP_DIR)) return true;
  // Lewati folder-folder di atas
  const topDir = relPath.split(path.sep)[0];
  if (BACKUP_SKIP_DIRS.has(topDir)) return true;
  return false;
}

/**
 * Tambahkan seluruh isi ROOT_DIR ke ZIP secara rekursif.
 * Melewati folder yang ada di BACKUP_SKIP_DIRS dan
 * file/folder yang dimulai dengan titik selain yang diizinkan.
 *
 * @param {AdmZip} zip
 */
function _addProjectToZip(zip) {
  const ALLOWED_DOT = new Set([".env.example", ".gitignore", ".replit"]);

  function walk(dir, zipBase) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const abs    = path.join(dir, entry.name);
      const relAbs = path.relative(ROOT_DIR, abs);

      // Lewati path yang masuk daftar skip
      if (_isSkippedPath(relAbs)) continue;

      // Lewati dotfile/dotdir kecuali yang diizinkan
      if (entry.name.startsWith(".") && !ALLOWED_DOT.has(entry.name)) continue;

      const zipPath = zipBase ? `${zipBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(abs, zipPath);
      } else {
        try {
          const content = fs.readFileSync(abs);
          zip.addFile(zipPath, content);
        } catch (err) {
          logger.warn(`[Database/Backup] Lewati file ${relAbs}: ${err.message}`);
        }
      }
    }
  }

  walk(ROOT_DIR, "");
}

/**
 * Buat file backup ZIP dari kondisi project yang sedang berjalan saat ini.
 *
 * Sumber: folder project di disk (ROOT_DIR) — langsung, real-time.
 * BUKAN dari GitHub, cache, atau backup sebelumnya.
 *
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

  // ── Seluruh isi project (src, data, config, assets, scripts, dll) ─────────
  // Membaca langsung dari disk — selalu mencerminkan kondisi terbaru project.
  _addProjectToZip(zip);

  // ── backup-info.json — metadata backup ────────────────────────────────────
  const info = {
    createdAt:  now.toISOString(),
    version:    _readPackageVersion(),
    source:     ROOT_DIR,
    excludes:   [...BACKUP_SKIP_DIRS, "dotfiles (kecuali .env.example/.gitignore/.replit)", "backup temp dir"],
    note:       "Backup langsung dari folder project aktif — bukan dari GitHub/cache/backup lama.",
  };
  zip.addFile("backup-info.json", Buffer.from(JSON.stringify(info, null, 2), "utf8"));

  // Tulis ke disk
  zip.writeZip(filePath);

  const stat  = fs.statSync(filePath);
  const tmpId = `bkp-${Date.now()}`;
  const entry = { filePath, fileName, size: stat.size, sizeStr: formatBytes(stat.size), createdAt: now.toISOString() };
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
 * Upload backup ke GitHub Releases.
 * Konfigurasi diambil dari panel Discord (Edit Kredensial) terlebih dahulu,
 * kemudian fallback ke environment variable jika belum diisi.
 * @param {string} tmpId
 * @returns {Promise<{ url: string }>}
 */
/**
 * Upload backup ke GitHub Releases (mode default).
 * @param {string} tmpId
 * @returns {Promise<{ url: string, mode: "release" }>}
 */
async function _uploadToRelease(tmpId, entry, token, repo, branch) {
  const releaseName = `Backup ${new Date(entry.createdAt).toLocaleDateString("id-ID")} [${branch}]`;
  const releaseRes  = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent":   "PangeranAssistantBot",
    },
    body: JSON.stringify({
      tag_name:         `backup-${Date.now()}`,
      name:              releaseName,
      body:              `Backup otomatis oleh Pangeran Assistant AI\nUkuran: ${entry.sizeStr}\nBranch: ${branch}`,
      draft:             false,
      prerelease:        true,
      target_commitish:  branch,
    }),
  });

  if (!releaseRes.ok) {
    const txt = await releaseRes.text().catch(() => "");
    throw new Error(`GitHub API error saat membuat release: ${releaseRes.status} — ${txt.slice(0, 200)}`);
  }

  const release   = await releaseRes.json();
  const fileData  = fs.readFileSync(entry.filePath);
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
  return { url: asset.browser_download_url ?? release.html_url, mode: "release" };
}

/**
 * Upload backup ke branch repository di folder /backups/.
 * Menggunakan GitHub Contents API — cocok untuk file ≤50 MB.
 * @param {string} tmpId
 * @returns {Promise<{ url: string, mode: "branch" }>}
 */
async function _uploadToBranch(entry, token, repo, branch) {
  const filePath  = `backups/${entry.fileName}`;
  const fileData  = fs.readFileSync(entry.filePath);
  const content   = fileData.toString("base64");

  // Cek apakah file sudah ada (untuk mendapatkan SHA kalau file perlu di-update)
  const checkRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        "application/vnd.github+json",
      "User-Agent":  "PangeranAssistantBot",
    },
  });

  let sha;
  if (checkRes.ok) {
    const existing = await checkRes.json();
    sha = existing.sha;
  }

  const body = {
    message: `Backup ${new Date(entry.createdAt).toLocaleDateString("id-ID")} — ${entry.sizeStr}`,
    content,
    branch,
    ...(sha ? { sha } : {}),
  };

  const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method:  "PUT",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent":   "PangeranAssistantBot",
    },
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    const txt = await putRes.text().catch(() => "");
    throw new Error(`GitHub API error saat branch upload: ${putRes.status} — ${txt.slice(0, 200)}`);
  }

  const putData = await putRes.json();
  const fileUrl = putData.content?.html_url ?? `https://github.com/${repo}/blob/${branch}/backups/`;
  return { url: fileUrl, mode: "branch" };
}

/**
 * Upload backup ke GitHub (Release atau Branch, sesuai konfigurasi uploadMode).
 * @param {string} tmpId
 * @returns {Promise<{ url: string, mode: string }>}
 */
export async function uploadBackupToGitHub(tmpId) {
  const entry = getBackupEntry(tmpId);
  if (!entry) throw new Error("File backup tidak ditemukan atau sudah kedaluwarsa.");

  const settings   = databaseDB.get();
  const token      = settings.github?.token  || process.env.GITHUB_TOKEN;
  const repo       = settings.github?.repo   || process.env.GITHUB_REPO;
  const branch     = settings.github?.branch || process.env.GITHUB_BRANCH || "main";
  const uploadMode = settings.github?.uploadMode ?? "release";

  if (!token) throw new Error("GitHub Token belum dikonfigurasi. Gunakan tombol 'Edit Kredensial' di panel Discord atau tambahkan GITHUB_TOKEN ke environment variable.");
  if (!repo)  throw new Error("GitHub Repository belum dikonfigurasi. Gunakan tombol 'Edit Kredensial' di panel Discord atau tambahkan GITHUB_REPO ke environment variable (format: owner/repo).");

  if (uploadMode === "branch") {
    return _uploadToBranch(entry, token, repo, branch);
  }
  return _uploadToRelease(tmpId, entry, token, repo, branch);
}


// ── GitHub Releases List ──────────────────────────────────────────────────────

/**
 * Ambil daftar GitHub Releases terbaru (maks 10) dari repository yang dikonfigurasi.
 * @returns {Promise<Array<{id,name,tag,createdAt,assets}>>}
 */
export async function listGitHubReleases() {
  const settings = databaseDB.get();
  const token    = settings.github?.token || process.env.GITHUB_TOKEN;
  const repo     = settings.github?.repo  || process.env.GITHUB_REPO;

  if (!token) throw new Error("GitHub Token belum dikonfigurasi.");
  if (!repo)  throw new Error("GitHub Repository belum dikonfigurasi.");

  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         "application/vnd.github+json",
      "User-Agent":   "PangeranAssistantBot",
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GitHub API error: ${res.status} — ${txt.slice(0, 200)}`);
  }
  const releases = await res.json();
  return releases.map(r => ({
    id:        String(r.id),
    name:      r.name || r.tag_name,
    tag:       r.tag_name,
    createdAt: r.created_at,
    assets:    (r.assets ?? []).map(a => ({
      id:          String(a.id),
      name:        a.name,
      size:        a.size,
      sizeStr:     formatBytes(a.size),
      downloadUrl: a.url,  // authenticated download URL (requires token)
    })),
  }));
}

// ── Restore from GitHub Release ───────────────────────────────────────────────

/**
 * Download sebuah release asset dari GitHub, extract ZIP-nya,
 * overwrite file project, lalu restart bot otomatis.
 *
 * File yang TIDAK di-overwrite: node_modules, .git, .cache, .local, .agents, bin
 *
 * @param {string} assetDownloadUrl  URL asset dari GitHub API (api.github.com/…)
 * @returns {Promise<{ restored: number }>}
 */
export async function restoreFromGitHubRelease(assetDownloadUrl) {
  const settings = databaseDB.get();
  const token    = settings.github?.token || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GitHub Token diperlukan untuk mengunduh release asset.");

  // 1. Download ZIP dari GitHub
  logger.info(`[Database/Restore] Downloading asset: ${assetDownloadUrl}`);
  const res = await fetch(assetDownloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        "application/octet-stream",
      "User-Agent":  "PangeranAssistantBot",
    },
  });
  if (!res.ok) throw new Error(`Download asset gagal: HTTP ${res.status}`);

  const buffer  = Buffer.from(await res.arrayBuffer());
  const tmpPath = path.join(os.tmpdir(), `restore-${Date.now()}.zip`);
  fs.writeFileSync(tmpPath, buffer);
  logger.info(`[Database/Restore] Downloaded ${formatBytes(buffer.length)}`);

  // 2. Extract dan overwrite
  const RESTORE_SKIP = new Set(["node_modules", ".git", ".cache", ".local", ".agents", "bin"]);
  const zip     = new AdmZip(tmpPath);
  const entries = zip.getEntries();

  let restored = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName.replace(/\\/g, "/");
    const topDir    = entryName.split("/")[0];
    if (RESTORE_SKIP.has(topDir)) continue;
    if (entryName === "backup-info.json") continue;

    const destPath = path.join(ROOT_DIR, entryName);
    const destDir  = path.dirname(destPath);
    try {
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
      restored++;
    } catch (err) {
      logger.warn(`[Database/Restore] Lewati ${entryName}: ${err.message}`);
    }
  }

  try { fs.unlinkSync(tmpPath); } catch {}
  logger.info(`[Database/Restore] Selesai: ${restored} file dipulihkan. Restart dalam 3 detik...`);

  // 3. Restart otomatis setelah reply berhasil dikirim ke Discord
  setTimeout(() => process.exit(0), 3_000);

  return { restored };
}

// ── Storage Stats ─────────────────────────────────────────────────────────────

/**
 * Hitung ukuran berbagai bagian project.
 * @returns {{ database: number, cache: number, temp: number, backup: number, assets: number, logs: number, total: number, strings: Object }}
 */
export function getStorageStats() {
  const db      = getDirSize(path.join(ROOT_DIR, "data"));
  const cache   = getDirSize(path.join(ROOT_DIR, "cache")) + getDirSize(path.join(ROOT_DIR, ".cache"));
  const tmp     = getDirSize(path.join(ROOT_DIR, "temp"))  + getDirSize(path.join(ROOT_DIR, "tmp"))  + getDirSize(BACKUP_TMP_DIR);
  const backup  = getDirSize(path.join(ROOT_DIR, "backup"));
  const assets  = getDirSize(path.join(ROOT_DIR, "assets"));
  const logs    = getDirSize(path.join(ROOT_DIR, "logs"));
  const src     = getDirSize(path.join(ROOT_DIR, "src"));
  const conf    = getDirSize(path.join(ROOT_DIR, "config"));
  const session = getDirSize(path.join(ROOT_DIR, "session"));
  const plugins = getDirSize(path.join(ROOT_DIR, "plugins"));
  const storage = getDirSize(path.join(ROOT_DIR, "storage"));
  const scripts = getDirSize(path.join(ROOT_DIR, "scripts"));
  const total   = db + cache + tmp + backup + assets + logs + src + conf + session + plugins + storage + scripts;

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
    config:   conf,
    session,
    plugins,
    storage,
    scripts,
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
      config:   formatBytes(conf),
      session:  formatBytes(session),
      plugins:  formatBytes(plugins),
      storage:  formatBytes(storage),
      scripts:  formatBytes(scripts),
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
