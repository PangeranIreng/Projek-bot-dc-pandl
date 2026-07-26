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

import {
  MANAGED_COOKIES_PATH,
  reloadCookies,
  getCookiesStatus,
  saveCookiesMeta,
  clearCookiesMeta,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Validate that a string looks like a Netscape cookies file. */
function _validateCookiesFormat(content) {
  const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
  // Must have at least one non-comment line with 7 tab-separated fields
  const dataLines = lines.filter(l => !l.startsWith("#"));
  if (dataLines.length === 0) return { ok: false, reason: "File tidak mengandung data cookie (hanya komentar atau kosong)." };

  const sampleLine = dataLines[0];
  const fields = sampleLine.split("\t");
  if (fields.length < 7) {
    return { ok: false, reason: "Format tidak valid. Pastikan file adalah format Netscape (tab-separated, 7 kolom per baris)." };
  }

  return { ok: true };
}

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
  fs.writeFileSync(MANAGED_COOKIES_PATH, content, "utf8");
  saveCookiesMeta({ uploadedAt: Date.now(), source, size: Buffer.byteLength(content, "utf8") });
  reloadCookies();
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
    const errText = (stderr || stderr || "").toLowerCase();
    if (title && !errText.includes("sign in")) return { ok: true, title };
    if (errText.includes("sign in") || errText.includes("login")) {
      return { ok: false, reason: "Cookies tidak valid atau kedaluwarsa. Perbarui dari browser." };
    }
    return title ? { ok: true, title } : { ok: false, reason: errText.slice(0, 200) || "No output" };
  } catch (err) {
    const msg = (err.stderr || err.message || "").toLowerCase();
    if (msg.includes("sign in") || msg.includes("cookies")) {
      return { ok: false, reason: "Cookies tidak valid atau kedaluwarsa." };
    }
    if (msg.includes("not found") || msg.includes("ENOENT")) {
      return { ok: false, reason: "yt-dlp tidak ditemukan. Bot belum selesai download binary." };
    }
    return { ok: false, reason: err.message?.slice(0, 200) ?? "Unknown error" };
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

    // ── Upload: URL ──────────────────────────────────────────────────────
    if (id === "bbrm:cookies:upload:url") {
      await interaction.showModal(buildCookiesUrlModal());
      return;
    }

    // ── Modal: paste submit ──────────────────────────────────────────────
    if (id === "bbrm:cookies:modal:paste" && interaction.isModalSubmit()) {
      const content = interaction.fields.getTextInputValue("cookies_content")?.trim() ?? "";

      // Validate format
      const validation = _validateCookiesFormat(content);
      if (!validation.ok) {
        await interaction.reply({
          embeds: [_errorEmbed("Format Cookies Tidak Valid", validation.reason)],
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

      logger.info(`[ResourceManager] Cookies diupload via paste oleh ${interaction.user.tag}`);

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
        embeds: [_processingEmbed("Mendownload Cookies...", `Mendownload dari:\n\`${url}\`\n\nHarap tunggu sebentar...`)],
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
      const validation = _validateCookiesFormat(dl.content);
      if (!validation.ok) {
        await interaction.editReply({
          embeds: [_errorEmbed("Format Cookies Tidak Valid", validation.reason)],
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

      logger.info(`[ResourceManager] Cookies didownload dari URL oleh ${interaction.user.tag}: ${url}`);

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
        logger.info(`[ResourceManager] Cookie test OK — title: ${result.title}`);
        await interaction.editReply({
          embeds: [_successEmbed("Cookies Valid ✅", `Cookies berhasil diverifikasi!\n\n**Video test:** ${result.title}\n\nCookies aktif dan akan digunakan untuk semua request YouTube dan Spotify.`)],
          components: [_backToCookiesRow()],
        });
      } else {
        logger.warn(`[ResourceManager] Cookie test FAILED: ${result.reason}`);
        await interaction.editReply({
          embeds: [_errorEmbed("Cookies Tidak Valid ❌", `${result.reason}\n\n**Solusi:**\n• Ekspor ulang cookies dari browser\n• Pastikan kamu sudah login ke YouTube\n• Gunakan ekstensi seperti \`Get cookies.txt LOCALLY\``)],
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
