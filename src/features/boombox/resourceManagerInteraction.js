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
    const content = Buffer.from(await response.arrayBuffer()).toString("utf8");
    const validation = validateCookiesContent(content);
    if (!validation.ok) {
      await message.reply(`❌ Format cookies tidak valid: ${validation.reason}`).catch(() => {});
      return true;
    }
    if (!validation.hasYoutubeCookie) {
      await message.reply("❌ File valid secara Netscape, tetapi tidak berisi cookie YouTube.").catch(() => {});
      return true;
    }

    _saveCookies(content, "file");
    await message.reply(
      "✅ Cookies berhasil disimpan secara permanen dan langsung diaktifkan untuk YouTube dan Spotify.\n" +
      "Gunakan tombol **🧪 Test Cookies** pada panel Resource Manager.",
    ).catch(() => {});
    await message.delete().catch(() => {});
  } catch (err) {
    logger.warn(`[ResourceManager] Cookie file import failed: ${_safeTestReason(err.message)}`);
    await message.reply("❌ File cookies tidak dapat diproses. Pastikan attachment dapat diakses dan tidak corrupt.").catch(() => {});
  }
  return true;
}

/** Test cookies by running yt-dlp with --simulate on a short YouTube video. */
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

async function _testCookiesPath(cookiesPath) {
  const ytdlpBin = _resolveYtdlpBinSync();
  const testUrl  = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  try {
    const { stdout, stderr } = await _execFileAsync(
      ytdlpBin,
      ["--cookies", cookiesPath, "--simulate", "--no-playlist", "--no-warnings", "--quiet", "--print", "title", testUrl],
      { timeout: 30_000, env: process.env },
    );
    const title = (stdout || "").trim();
    const errText = (stderr || "").toLowerCase();
    if (title && !errText.includes("sign in")) return { ok: true, title };
    if (errText.includes("sign in") || errText.includes("login")) {
      return { ok: false, reason: "Cookies tidak valid atau kedaluwarsa. Perbarui dari browser." };
    }
    return title ? { ok: true, title } : { ok: false, reason: _safeTestReason(errText) || "No output" };
  } catch (err) {
    const msg = (err.stderr || err.message || "").toLowerCase();
    if (msg.includes("sign in") || msg.includes("cookies")) {
      return { ok: false, reason: "Cookies tidak valid atau kedaluwarsa." };
    }
    if (msg.includes("not found") || msg.includes("ENOENT")) {
      return { ok: false, reason: "yt-dlp tidak ditemukan. Bot belum selesai download binary." };
    }
    return { ok: false, reason: _safeTestReason(err.message) };
  }
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
      const content = interaction.fields.getTextInputValue("cookies_content")?.trim() ?? "";

      // Validate format
      const validation = validateCookiesContent(content);
      if (!validation.ok) {
        await interaction.reply({
          embeds: [_errorEmbed("Format Cookies Tidak Valid", validation.reason)],
          components: [_backToCookiesRow()],
          ephemeral: true,
        });
        return;
      }
      if (!validation.hasYoutubeCookie) {
        await interaction.reply({
          embeds: [_errorEmbed("Cookies YouTube Tidak Ditemukan", "Format Netscape valid, tetapi file tidak berisi cookie YouTube.")],
          components: [_backToCookiesRow()],
          ephemeral: true,
        });
        return;
      }

      // Save
      try {
        _saveCookies(content, "paste");
      } catch (err) {
        await interaction.reply({
          embeds: [_errorEmbed("Gagal Menyimpan Cookies", `Error: ${err.message}`)],
          components: [_backToCookiesRow()],
          ephemeral: true,
        });
        return;
      }

      logger.info("[ResourceManager] Cookies imported via paste");

      // Show success with option to test
      const { embed, components } = buildCookiesPanel();
      const testRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("bbrm:cookies:test").setLabel("🧪 Test Sekarang").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("bbrm:cookies:panel").setLabel("Lewati").setStyle(ButtonStyle.Secondary),
      );

      await interaction.update({
        embeds: [
          _successEmbed("Cookies Berhasil Disimpan", "Cookies YouTube telah disimpan dan langsung aktif untuk semua download YouTube dan Spotify.\n\nDisarankan untuk **test cookies** terlebih dahulu."),
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

      // Validate format
      const validation = validateCookiesContent(dl.content);
      if (!validation.ok) {
        await interaction.editReply({
          embeds: [_errorEmbed("Format Cookies Tidak Valid", validation.reason)],
          components: [_backToCookiesRow()],
        });
        return;
      }
      if (!validation.hasYoutubeCookie) {
        await interaction.editReply({
          embeds: [_errorEmbed("Cookies YouTube Tidak Ditemukan", "Format Netscape valid, tetapi file tidak berisi cookie YouTube.")],
          components: [_backToCookiesRow()],
        });
        return;
      }

      // Save
      try {
        _saveCookies(dl.content, "url");
      } catch (err) {
        await interaction.editReply({
          embeds: [_errorEmbed("Gagal Menyimpan Cookies", `Error: ${err.message}`)],
          components: [_backToCookiesRow()],
        });
        return;
      }

      logger.info("[ResourceManager] Cookies imported via URL");

      const testRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("bbrm:cookies:test").setLabel("🧪 Test Sekarang").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("bbrm:cookies:panel").setLabel("Lewati").setStyle(ButtonStyle.Secondary),
      );

      await interaction.editReply({
        embeds: [_successEmbed("Cookies Berhasil Disimpan", "Cookies berhasil didownload dan disimpan. Sekarang aktif untuk YouTube dan Spotify.")],
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
        logger.info("[ResourceManager] Cookie test OK");
        await interaction.editReply({
          embeds: [_successEmbed("Cookies Valid ✅", `Cookies berhasil diverifikasi!\n\n**Video test:** ${result.title}\n\nCookies aktif dan akan digunakan untuk semua request YouTube dan Spotify.`)],
          components: [_backToCookiesRow()],
        });
      } else {
        recordCookiesTest({ ok: false, reason: _safeTestReason(result.reason) });
        logger.warn(`[ResourceManager] Cookie test FAILED: ${_safeTestReason(result.reason)}`);
        await interaction.editReply({
          embeds: [_errorEmbed("Cookies Tidak Valid ❌", `${_safeTestReason(result.reason)}\n\n**Solusi:**\n• Ekspor ulang cookies dari browser\n• Pastikan kamu sudah login ke YouTube\n• Gunakan ekstensi seperti \`Get cookies.txt LOCALLY\``)],
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
