/**
 * resourceManagerInteraction.js — Handler untuk semua interaksi bbrm:
 *
 * Prefix routing:
 *   bbrm:resource:panel          → Panel utama Resource Manager
 *   bbrm:menu:select             → Dropdown navigasi
 *   bbrm:cookies:panel           → Panel cookies
 *   bbrm:cookies:upload:paste    → Modal paste konten cookies
 *   bbrm:cookies:upload:url      → Modal URL cookies
 *   bbrm:cookies:modal:paste     → Submit paste modal
 *   bbrm:cookies:modal:url       → Submit URL modal
 *   bbrm:cookies:test            → Test cookies dengan yt-dlp
 *   bbrm:cookies:delete          → Konfirmasi hapus
 *   bbrm:cookies:delete:confirm  → Eksekusi hapus cookies
 *   bbrm:gif:panel               → Panel GIF resource
 *   bbrm:gif:enable              → Aktifkan GIF
 *   bbrm:gif:disable             → Nonaktifkan GIF
 *   bbrm:gif:manage              → Delegasi ke bbdash:gif panel
 */

import fs           from "node:fs";
import https        from "node:https";
import http         from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path         from "node:path";
import { fileURLToPath } from "node:url";

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { logger } from "../../utils/logger.js";
import { db }     from "../../database/db.js";
import { isOwner } from "../../middleware/permissions.js";

import {
  MANAGED_COOKIES_PATH,
  reloadCookies,
  getCookiesStatus,
  saveCookiesMeta,
  clearCookiesMeta,
  validateCookiesContent,
  recordCookiesTest,
} from "../../utils/cookiesResolver.js";

import { parseCookiesAuto, formatLabel } from "../../utils/cookieParser.js";

import {
  buildResourceManagerPanel,
  buildCookiesPanel,
  buildCookiesPasteModal,
  buildCookiesUrlModal,
  buildCookiesDeleteConfirmPanel,
  buildGifResourcePanel,
} from "./setup/resourceManager.js";

import {
  buildDashboardGifPanel,
} from "./setup/dashboardSetup.js";

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..", "..");
const FOOTER = "BoomBox • Resource Manager";
const COLOR  = 0x5865f2;

const _execFileAsync = promisify(execFile);
const MAX_COOKIE_BYTES = 2 * 1024 * 1024;
const pendingFileUploads = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Download content from a URL. Returns { ok, content, reason }. */
function _downloadUrl(url, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    const proto = url.startsWith("https:") ? https : http;
    const req = proto.get(url, { timeout: 15_000, headers: { "User-Agent": "BoomBoxBot/1.0" } }, (res) => {
      if (res.statusCode !== 200) {
        return resolve({ ok: false, reason: `HTTP ${res.statusCode}` });
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          return resolve({ ok: false, reason: `File terlalu besar (max 2 MB). Gunakan metode paste untuk file kecil.` });
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ ok: true, content: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (err) => resolve({ ok: false, reason: err.message }));
    });
    req.on("error", (err) => resolve({ ok: false, reason: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, reason: "Timeout saat mendownload cookies (>15 detik)." }); });
  });
}

/** Save cookies content to disk and reload the resolver. */
function _saveCookies(content, source) {
  fs.mkdirSync(path.dirname(MANAGED_COOKIES_PATH), { recursive: true });
  const tempPath = `${MANAGED_COOKIES_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, MANAGED_COOKIES_PATH);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
  saveCookiesMeta({
    uploadedAt: Date.now(),
    source,
    size: Buffer.byteLength(content, "utf8"),
    lastTestAt: null,
    lastTestOk: null,
    lastTestReason: null,
  });
  reloadCookies();
}

function _safeTestReason(reason) {
  return String(reason ?? "Cookies tidak lolos test")
    .replace(/(--cookies(?:-from-browser)?\s+)(\S+)/gi, "$1[redacted]")
    .replace(/(?:sid|sapisid|hsid|ssid|__secure-[a-z0-9_-]+)=\S+/gi, "[redacted]")
    .slice(0, 240);
}

function _queueFileUpload(interaction) {
  const key = `${interaction.user.id}:${interaction.channelId}`;
  pendingFileUploads.set(key, { expiresAt: Date.now() + 120_000 });
  const timer = setTimeout(() => pendingFileUploads.delete(key), 120_000);
  timer.unref?.();
}

/**
 * Discord modals cannot contain file inputs. After the owner presses
 * "Upload File", accept one .txt attachment in the same channel, validate it
 * in memory, persist it atomically, and remove the source message.
 */
export async function handleCookieUploadMessage(message) {
  if (message.author?.bot || !message.attachments?.size) return false;
  const key = `${message.author.id}:${message.channelId}`;
  const pending = pendingFileUploads.get(key);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingFileUploads.delete(key);
    return false;
  }
  pendingFileUploads.delete(key);

  if (message.attachments.size !== 1) {
    await message.reply("❌ Upload cookies ditolak. Kirim tepat satu file `.txt`.").catch(() => {});
    return true;
  }

  const attachment = message.attachments.first();
  const fileName = String(attachment?.name ?? "").toLowerCase();
  if (!attachment || !fileName.endsWith(".txt")) {
    await message.reply("❌ Upload cookies ditolak. Kirim satu file `.txt` berformat Netscape.").catch(() => {});
    return true;
  }
  if (attachment.size > MAX_COOKIE_BYTES) {
    await message.reply("❌ Upload cookies ditolak. Ukuran maksimum file adalah 2 MB.").catch(() => {});
    return true;
  }

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rawContent = Buffer.from(await response.arrayBuffer()).toString("utf8");

    // Auto-detect format and convert to Netscape
    const parsed = parseCookiesAuto(rawContent);
    if (!parsed.ok) {
      await message.reply(`❌ ${parsed.reason}`).catch(() => {});
      return true;
    }

    // Validate the resulting Netscape content
    const validation = validateCookiesContent(parsed.content);
    if (!validation.ok) {
      await message.reply(`❌ Validasi cookies gagal: ${validation.reason}`).catch(() => {});
      return true;
    }
    if (!validation.hasYoutubeCookie) {
      await message.reply("❌ Cookies berhasil diparsing, namun tidak berisi cookie domain YouTube yang dibutuhkan.").catch(() => {});
      return true;
    }

    const sourceLabel = `file · ${formatLabel(parsed.format)}`;
    _saveCookies(parsed.content, sourceLabel);

    const countInfo = parsed.youtubeCookieCount != null
      ? ` (${parsed.youtubeCookieCount} cookie relevan${parsed.totalParsed != null ? ` dari ${parsed.totalParsed}` : ""})`
      : "";
    logger.info(`[ResourceManager] Cookies imported via file (format: ${parsed.format})`);

    await message.reply(
      `✅ Cookies berhasil disimpan secara permanen dan langsung diaktifkan untuk YouTube dan Spotify.\n` +
      `📋 Format terdeteksi: **${formatLabel(parsed.format)}**${countInfo}\n` +
      "Gunakan tombol **🧪 Test Cookies** pada panel Resource Manager.",
    ).catch(() => {});
    await message.delete().catch(() => {});
  } catch (err) {
    logger.warn(`[ResourceManager] Cookie file import failed: ${_safeTestReason(err.message)}`);
    await message.reply("❌ File cookies tidak dapat diproses. Pastikan attachment dapat diakses dan tidak corrupt.").catch(() => {});
  }
  return true;
}

/** Resolve the yt-dlp binary path (system path first, then bundled). */
function _resolveYtdlpBinSync() {
  const BIN_DIR = path.join(PROJECT_ROOT, "bin");
  const suffix  = process.platform === "win32" ? ".exe"
                : process.platform === "linux"  ? "_linux"
                : "_macos";
  const candidates = [
    path.join(BIN_DIR, `yt-dlp${suffix}`),
    path.join(BIN_DIR, "yt-dlp"),
    "yt-dlp",
  ];
  for (const b of candidates) {
    if (b === "yt-dlp") return "yt-dlp"; // assume system
    if (fs.existsSync(b)) return b;
  }
  return "yt-dlp";
}

/**
 * Classify a yt-dlp error into one of 7 categories without exposing cookie values.
 *
 * Returns:
 *   { category, embedTitle, reason, solution, conclusive }
 *
 * conclusive: true  → definitely a cookie problem (record as failed test)
 * conclusive: false → inconclusive; cookies may still be valid
 */
function _classifyYtdlpError(rawStderr, exitCode) {
  const raw = rawStderr ?? "";
  const s   = raw.toLowerCase();

  // ── 1. yt-dlp binary missing ────────────────────────────────────────────
  if (exitCode === 127 || /no such file or directory|enoent/i.test(raw)) {
    return {
      category:   "ytdlp-missing",
      embedTitle: "yt-dlp Tidak Ditemukan",
      reason:     "Binary yt-dlp tidak ditemukan di sistem. Bot mungkin belum selesai download binary.",
      solution:   "• Tunggu beberapa menit lalu coba lagi\n• Jika masalah berlanjut, restart bot",
      conclusive: false,
    };
  }

  // ── 2. Anti-bot / rate limit (check before auth to avoid misclassification) ─
  if (/429|too many requests|rate.?limit|unusual traffic|automated|captcha|please verify|confirm you.re not a bot/i.test(s)) {
    return {
      category:   "anti-bot",
      embedTitle: "Anti-Bot / Rate Limit",
      reason:     "YouTube mendeteksi traffic otomatis dan membatasi akses dari IP server ini.",
      solution:   "• Tunggu beberapa menit sebelum test ulang\n• Cookies kemungkinan **masih valid** — ini bukan masalah cookies",
      conclusive: false,
    };
  }

  // ── 3. Cookies expired ──────────────────────────────────────────────────
  if (/expired|kedaluwarsa/i.test(s) &&
      /sign in|log in|login|session|cookie|auth/i.test(s)) {
    return {
      category:   "cookies-expired",
      embedTitle: "Cookies Kedaluwarsa",
      reason:     "Session YouTube sudah expired — cookies tidak lagi diterima.",
      solution:   "• Login ulang ke YouTube di browser\n• Ekspor cookies baru menggunakan `Get cookies.txt LOCALLY`\n• Import ulang melalui Resource Manager",
      conclusive: true,
    };
  }

  // ── 4. Cookies invalid / auth required ─────────────────────────────────
  if (/sign in|log in|login|not logged in|please sign|confirm your age|requires authentication|this video requires/i.test(s)) {
    return {
      category:   "cookies-invalid",
      embedTitle: "Cookies Tidak Valid",
      reason:     "YouTube meminta sign-in — cookies tidak dikenali, salah format, atau sudah tidak berlaku.",
      solution:   "• Pastikan kamu sudah **login** ke YouTube di browser\n• Ekspor ulang cookies menggunakan ekstensi `Get cookies.txt LOCALLY` atau `EditThisCookie`\n• Import ulang melalui Resource Manager",
      conclusive: true,
    };
  }

  // ── 5. Network error ────────────────────────────────────────────────────
  if (/unable to download webpage|failed to establish|connection refused|connection reset|timed out|timeout|ssl error|getaddrinfo|eof occurred|network is unreachable|broken pipe/i.test(s)) {
    return {
      category:   "network",
      embedTitle: "Network Error",
      reason:     "Tidak dapat terhubung ke YouTube dari server.",
      solution:   "• Periksa koneksi internet server\n• Coba lagi beberapa saat\n• Cookies tidak diubah statusnya — mungkin masih valid",
      conclusive: false,
    };
  }

  // ── 6. Extractor / parser error ─────────────────────────────────────────
  if (/extractorerror|unable to extract|parsing json|parsing error|regex/i.test(s)) {
    return {
      category:   "extractor",
      embedTitle: "Extractor Error",
      reason:     "yt-dlp gagal mem-parse halaman YouTube. YouTube mungkin mengubah struktur halamannya.",
      solution:   "• Cookies kemungkinan **masih valid** — ini bukan masalah cookies\n• Pertimbangkan untuk update yt-dlp ke versi terbaru",
      conclusive: false,
    };
  }

  // ── 7. Video-level error (NOT a cookies problem) ────────────────────────
  if (/video unavailable|private video|has been removed|does not exist|this video is not available|geo.?restrict|not available in your country|age.?restrict|members?.only|premium|format is not available|requested format/i.test(s)) {
    return {
      category:   "video-error",
      embedTitle: "Video Error (Bukan Masalah Cookies)",
      reason:     "Video test tidak dapat diakses (dihapus, privat, dibatasi wilayah, atau format tidak tersedia). Ini **bukan** masalah cookies.",
      solution:   "• Cookies kemungkinan **valid** — ini adalah error pada video test\n• Autentikasi berhasil, namun video test bermasalah",
      conclusive: false,
    };
  }

  // ── Unknown ─────────────────────────────────────────────────────────────
  return {
    category:   "unknown",
    embedTitle: "Error Tidak Dikenal",
    reason:     null,
    solution:   "• Cek log bot untuk detail lebih lanjut\n• Coba test ulang beberapa saat kemudian",
    conclusive: false,
  };
}

/**
 * Test cookies by fetching YouTube video metadata via yt-dlp.
 *
 * Uses --print "%(id)s::%(title)s" WITHOUT --simulate so that format
 * selection is never triggered. "Requested format is not available" and
 * similar video/format errors can never occur with this approach.
 *
 * Returns:
 *   { ok: true,  title, note? }
 *   { ok: false, category, embedTitle, reason, solution, conclusive }
 */
async function _testCookiesPath(cookiesPath) {
  const ytdlpBin = _resolveYtdlpBinSync();
  // Rick Roll is highly reliable and publicly available worldwide.
  const testUrl  = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const result = await _execFileAsync(
      ytdlpBin,
      [
        "--cookies",    cookiesPath,
        "--no-playlist",
        "--no-warnings",
        // Metadata-only print — does NOT trigger format selection.
        // %(id)s and %(title)s are info-extractor fields, resolved before
        // any download/format pipeline runs.
        "--print",      "%(id)s::%(title)s",
        testUrl,
      ],
      { timeout: 30_000, env: process.env },
    );
    stdout   = result.stdout ?? "";
    stderr   = result.stderr ?? "";
    exitCode = 0;
  } catch (err) {
    stdout   = err.stdout  ?? "";
    stderr   = err.stderr  ?? err.message ?? "";
    exitCode = err.code    ?? 1;
  }

  // ── Parse output ─────────────────────────────────────────────────────────
  const firstLine = (stdout.trim().split("\n")[0] ?? "").trim();
  const sepIdx    = firstLine.indexOf("::");
  const videoId   = sepIdx > 0 ? firstLine.slice(0, sepIdx).trim()  : "";
  const title     = sepIdx > 0 ? firstLine.slice(sepIdx + 2).trim() : firstLine;

  // A valid yt-dlp video ID is exactly 11 URL-safe characters.
  if (videoId && /^[A-Za-z0-9_\-]{11}$/.test(videoId)) {
    return { ok: true, title: title || videoId };
  }

  // ── Classify the error ────────────────────────────────────────────────────
  const classification = _classifyYtdlpError(stderr, exitCode);

  // Video/format errors mean auth SUCCEEDED — cookies are working.
  if (classification.category === "video-error") {
    return {
      ok:    true,
      title: "(autentikasi berhasil)",
      note:  classification.reason,
    };
  }

  return { ok: false, ...classification };
}

// ── Processing embed helper ───────────────────────────────────────────────────

function _processingEmbed(title, desc) {
  return new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle(`⏳ ${title}`)
    .setDescription(desc)
    .setFooter({ text: FOOTER });
}

function _successEmbed(title, desc) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`✅ ${title}`)
    .setDescription(desc)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function _errorEmbed(title, desc) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`❌ ${title}`)
    .setDescription(desc)
    .setFooter({ text: FOOTER });
}

function _backToCookiesRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbrm:cookies:panel").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
  );
}

// ── Main Handler ──────────────────────────────────────────────────────────────

/**
 * Handle all interactions whose customId starts with "bbrm:".
 * @param {import("discord.js").Interaction} interaction
 */
export async function handleResourceManagerInteraction(interaction) {
  const id = interaction.customId ?? "";

  try {
    if (id.startsWith("bbrm:cookies:") && !isOwner(interaction.member)) {
      await interaction.reply({
        content: "❌ Hanya Owner yang dapat mengelola YouTube Cookies.",
        ephemeral: true,
      });
      return;
    }

    // ── Resource Manager main panel ──────────────────────────────────────
    if (id === "bbrm:resource:panel") {
      const { embed, components } = buildResourceManagerPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── Dropdown navigation ──────────────────────────────────────────────
    if (id === "bbrm:menu:select" && interaction.isStringSelectMenu()) {
      const val = interaction.values[0];
      if (val === "cookies") {
        const { embed, components } = buildCookiesPanel();
        await interaction.update({ embeds: [embed], components });
      } else if (val === "gif") {
        const { embed, components } = buildGifResourcePanel();
        await interaction.update({ embeds: [embed], components });
      } else if (val === "status") {
        const { embed, components } = buildResourceManagerPanel();
        await interaction.update({ embeds: [embed], components });
      }
      return;
    }

    // ── Cookies panel ────────────────────────────────────────────────────
    if (id === "bbrm:cookies:panel") {
      const { embed, components } = buildCookiesPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── Upload: paste ────────────────────────────────────────────────────
    if (id === "bbrm:cookies:upload:paste") {
      await interaction.showModal(buildCookiesPasteModal());
      return;
    }

    // ── Upload: file attachment ──────────────────────────────────────────
    if (id === "bbrm:cookies:upload:file") {
      _queueFileUpload(interaction);
      await interaction.reply({
        content:
          "📎 Kirim **satu file `.txt`** cookies.txt di channel ini dalam 2 menit.\n" +
          "File akan divalidasi, disimpan aman, lalu pesan attachment dihapus bila bot memiliki izin.",
        ephemeral: true,
      });
      return;
    }

    // ── Upload: URL ──────────────────────────────────────────────────────
    if (id === "bbrm:cookies:upload:url") {
      await interaction.showModal(buildCookiesUrlModal());
      return;
    }

    // ── Modal: paste submit ──────────────────────────────────────────────
    if (id === "bbrm:cookies:modal:paste" && interaction.isModalSubmit()) {
      const rawContent = interaction.fields.getTextInputValue("cookies_content")?.trim() ?? "";

      // Auto-detect format and convert to Netscape
      const parsed = parseCookiesAuto(rawContent);
      if (!parsed.ok) {
        await interaction.reply({
          embeds: [_errorEmbed("Cookies Tidak Dapat Diproses", parsed.reason)],
          components: [_backToCookiesRow()],
          ephemeral: true,
        });
        return;
      }

      // Validate the resulting Netscape content
      const validation = validateCookiesContent(parsed.content);
      if (!validation.ok) {
        await interaction.reply({
          embeds: [_errorEmbed("Validasi Cookies Gagal", validation.reason)],
          components: [_backToCookiesRow()],
          ephemeral: true,
        });
        return;
      }
      if (!validation.hasYoutubeCookie) {
        await interaction.reply({
          embeds: [_errorEmbed("Cookies YouTube Tidak Ditemukan", "Cookies berhasil diparsing, namun tidak berisi cookie domain YouTube yang dibutuhkan.")],
          components: [_backToCookiesRow()],
          ephemeral: true,
        });
        return;
      }

      // Save
      const sourceLabel = `paste · ${formatLabel(parsed.format)}`;
      try {
        _saveCookies(parsed.content, sourceLabel);
      } catch (err) {
        await interaction.reply({
          embeds: [_errorEmbed("Gagal Menyimpan Cookies", `Error: ${err.message}`)],
          components: [_backToCookiesRow()],
          ephemeral: true,
        });
        return;
      }

      logger.info(`[ResourceManager] Cookies imported via paste (format: ${parsed.format})`);

      // Success message with detected format and cookie count
      const countInfo = parsed.youtubeCookieCount != null
        ? `\n🍪 Cookie relevan: **${parsed.youtubeCookieCount}**${parsed.totalParsed != null ? ` dari ${parsed.totalParsed} yang dibaca` : ""}`
        : `\n🍪 Cookie YouTube: **${validation.youtubeCookieCount}**`;
      const fmtInfo = `\n📋 Format terdeteksi: **${formatLabel(parsed.format)}**`;

      const testRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("bbrm:cookies:test").setLabel("🧪 Test Sekarang").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("bbrm:cookies:panel").setLabel("Lewati").setStyle(ButtonStyle.Secondary),
      );

      await interaction.update({
        embeds: [
          _successEmbed(
            "Cookies Berhasil Disimpan",
            "Cookies YouTube telah disimpan dan langsung aktif untuk semua download YouTube dan Spotify." +
            fmtInfo + countInfo +
            "\n\nDisarankan untuk **test cookies** terlebih dahulu.",
          ),
        ],
        components: [testRow],
      });
      return;
    }

    // ── Modal: URL submit ────────────────────────────────────────────────
    if (id === "bbrm:cookies:modal:url" && interaction.isModalSubmit()) {
      const url = interaction.fields.getTextInputValue("cookies_url")?.trim() ?? "";

      // Basic URL validation
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        await interaction.reply({
          embeds: [_errorEmbed("URL Tidak Valid", "URL harus dimulai dengan `https://` atau `http://`.")],
          components: [_backToCookiesRow()],
          ephemeral: true,
        });
        return;
      }

      // Show processing state
      await interaction.update({
        embeds: [_processingEmbed("Mendownload Cookies...", "Mengambil file cookies dari URL. URL tidak disimpan setelah proses selesai.\n\nHarap tunggu sebentar...")],
        components: [],
      });

      // Download
      const dl = await _downloadUrl(url);
      if (!dl.ok) {
        const { embed, components } = buildCookiesPanel();
        await interaction.editReply({
          embeds: [_errorEmbed("Gagal Download Cookies", `${dl.reason}\n\nPeriksa URL dan pastikan file dapat diakses publik.`)],
          components: [_backToCookiesRow()],
        });
        return;
      }

      // Auto-detect format and convert to Netscape
      const parsed = parseCookiesAuto(dl.content);
      if (!parsed.ok) {
        await interaction.editReply({
          embeds: [_errorEmbed("Cookies Tidak Dapat Diproses", parsed.reason)],
          components: [_backToCookiesRow()],
        });
        return;
      }

      // Validate the resulting Netscape content
      const validation = validateCookiesContent(parsed.content);
      if (!validation.ok) {
        await interaction.editReply({
          embeds: [_errorEmbed("Validasi Cookies Gagal", validation.reason)],
          components: [_backToCookiesRow()],
        });
        return;
      }
      if (!validation.hasYoutubeCookie) {
        await interaction.editReply({
          embeds: [_errorEmbed("Cookies YouTube Tidak Ditemukan", "Cookies berhasil diparsing, namun tidak berisi cookie domain YouTube yang dibutuhkan.")],
          components: [_backToCookiesRow()],
        });
        return;
      }

      // Save
      const sourceLabel = `url · ${formatLabel(parsed.format)}`;
      try {
        _saveCookies(parsed.content, sourceLabel);
      } catch (err) {
        await interaction.editReply({
          embeds: [_errorEmbed("Gagal Menyimpan Cookies", `Error: ${err.message}`)],
          components: [_backToCookiesRow()],
        });
        return;
      }

      logger.info(`[ResourceManager] Cookies imported via URL (format: ${parsed.format})`);

      const countInfo = parsed.youtubeCookieCount != null
        ? `\n🍪 Cookie relevan: **${parsed.youtubeCookieCount}**${parsed.totalParsed != null ? ` dari ${parsed.totalParsed} yang dibaca` : ""}`
        : `\n🍪 Cookie YouTube: **${validation.youtubeCookieCount}**`;
      const fmtInfo = `\n📋 Format terdeteksi: **${formatLabel(parsed.format)}**`;

      const testRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("bbrm:cookies:test").setLabel("🧪 Test Sekarang").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("bbrm:cookies:panel").setLabel("Lewati").setStyle(ButtonStyle.Secondary),
      );

      await interaction.editReply({
        embeds: [_successEmbed(
          "Cookies Berhasil Disimpan",
          "Cookies berhasil didownload dan disimpan. Sekarang aktif untuk YouTube dan Spotify." +
          fmtInfo + countInfo,
        )],
        components: [testRow],
      });
      return;
    }

    // ── Test cookies ─────────────────────────────────────────────────────
    if (id === "bbrm:cookies:test") {
      const st = getCookiesStatus();
      if (!st.hasCookies || !st.path) {
        await interaction.update({
          embeds: [_errorEmbed("Tidak Ada Cookies", "Upload cookies terlebih dahulu sebelum melakukan test.")],
          components: [_backToCookiesRow()],
        });
        return;
      }

      // Show processing
      await interaction.update({
        embeds: [_processingEmbed("Menguji Cookies...", "Menjalankan yt-dlp dengan cookies untuk memverifikasi validitas...\nHarap tunggu (maks 30 detik).")],
        components: [],
      });

      const result = await _testCookiesPath(st.path);

      if (result.ok) {
        recordCookiesTest({ ok: true });
        logger.info(`[ResourceManager] Cookie test OK — ${result.title ?? "n/a"}`);

        let desc = `Cookies berhasil diverifikasi dan diterima YouTube.\n\n**Video test:** ${result.title}\n\nCookies aktif dan akan digunakan untuk semua request YouTube dan Spotify.`;
        if (result.note) {
          desc += `\n\n⚠️ Catatan: ${result.note}`;
        }

        await interaction.editReply({
          embeds: [_successEmbed("Cookies Valid ✅", desc)],
          components: [_backToCookiesRow()],
        });
      } else {
        // For conclusive failures (invalid/expired), record as failed.
        // For inconclusive (network, anti-bot, extractor), still record for
        // lastTestAt timestamp but with a neutral reason so panel stays 🟡.
        const safeReason = result.conclusive
          ? _safeTestReason(result.reason ?? result.embedTitle)
          : `[${result.category}] ${_safeTestReason(result.reason ?? result.embedTitle)}`;

        recordCookiesTest({ ok: false, reason: safeReason });
        logger.warn(`[ResourceManager] Cookie test — ${result.category}: ${_safeTestReason(result.reason ?? result.embedTitle)}`);

        // Build a category-specific embed
        const categoryIcon = {
          "cookies-invalid": "🔴",
          "cookies-expired": "🔴",
          "anti-bot":        "🟡",
          "network":         "🟡",
          "ytdlp-missing":   "🟡",
          "extractor":       "🟡",
          "video-error":     "🟡",
          "unknown":         "🟡",
        }[result.category] ?? "🔴";

        const reasonLine = result.reason ? `**Penyebab:** ${result.reason}\n\n` : "";
        const solutionLine = result.solution ? `**Solusi:**\n${result.solution}` : "";

        await interaction.editReply({
          embeds: [_errorEmbed(
            `${categoryIcon} ${result.embedTitle ?? "Test Gagal"}`,
            reasonLine + solutionLine,
          )],
          components: [_backToCookiesRow()],
        });
      }
      return;
    }

    // ── Delete: show confirm ──────────────────────────────────────────────
    if (id === "bbrm:cookies:delete") {
      const { embed, components } = buildCookiesDeleteConfirmPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── Delete: confirm ───────────────────────────────────────────────────
    if (id === "bbrm:cookies:delete:confirm") {
      let deleted = false;
      try {
        if (fs.existsSync(MANAGED_COOKIES_PATH)) {
          fs.unlinkSync(MANAGED_COOKIES_PATH);
          deleted = true;
        }
        clearCookiesMeta();
        reloadCookies();
        logger.info(`[ResourceManager] Cookies dihapus oleh ${interaction.user.tag}`);
      } catch (err) {
        await interaction.update({
          embeds: [_errorEmbed("Gagal Menghapus Cookies", `Error: ${err.message}`)],
          components: [_backToCookiesRow()],
        });
        return;
      }

      const { embed, components } = buildCookiesPanel();
      await interaction.update({
        embeds: [_successEmbed("Cookies Dihapus", deleted
          ? "File cookies.txt berhasil dihapus. BoomBox akan berjalan tanpa cookies."
          : "Tidak ada file cookies yang dikelola Resource Manager. BoomBox sudah berjalan tanpa cookies.")],
        components: [_backToCookiesRow()],
      });
      return;
    }

    // ── GIF: resource panel ──────────────────────────────────────────────
    if (id === "bbrm:gif:panel") {
      const { embed, components } = buildGifResourcePanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── GIF: enable ──────────────────────────────────────────────────────
    if (id === "bbrm:gif:enable") {
      db.setDashboard({ showGif: true });
      logger.info("[ResourceManager] GIF diaktifkan");
      const { embed, components } = buildGifResourcePanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── GIF: disable ─────────────────────────────────────────────────────
    if (id === "bbrm:gif:disable") {
      db.setDashboard({ showGif: false });
      logger.info("[ResourceManager] GIF dinonaktifkan — BoomBox menggunakan embed biasa");
      const { embed, components } = buildGifResourcePanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── GIF: manage URLs (delegate to existing bbdash:gif panel) ─────────
    if (id === "bbrm:gif:manage") {
      const { embed, components } = buildDashboardGifPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // Unknown
    logger.debug(`[ResourceManager] Unknown interaction: ${id}`);

  } catch (err) {
    logger.error(`[ResourceManager] Interaction error for "${id}": ${err.message}`);
    const content = "❌ Terjadi kesalahan pada Resource Manager.";
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    } else if (interaction.deferred) {
      await interaction.editReply({ content }).catch(() => {});
    }
  }
}
