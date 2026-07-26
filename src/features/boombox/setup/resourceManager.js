/**
 * resourceManager.js — BoomBox Resource Manager UI panels.
 *
 * Manages all BoomBox resources:
 *   • YouTube Cookies (upload, replace, delete, test, status)
 *   • GIF settings (active status + link to bbdash:gif panel)
 *   • Full status dashboard (🟢🟡🔴 per component)
 *
 * CustomId prefix: bbrm:
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { getCookiesStatus } from "../../../utils/cookiesResolver.js";
import * as providerHealth  from "../../../services/providerHealth.js";
import { getQueueSnapshot } from "../../queue/boomboxQueue.js";
import { getAllSnapshots }   from "../../queue/workerManager.js";
import { getCacheStats }     from "../../../services/boomboxCache.js";
import { db }               from "../../../database/db.js";

const COLOR  = 0x5865f2;
const FOOTER = "BoomBox • Resource Manager";

// ── Helpers ───────────────────────────────────────────────────────────────────

function _indicator(ok, warn) {
  if (ok === null || ok === undefined) return warn ? "🟡" : "🔴";
  return ok ? "🟢" : (warn ? "🟡" : "🔴");
}

function _formatBytes(b) {
  if (!b && b !== 0) return "—";
  if (b < 1024)       return `${b} B`;
  if (b < 1048576)    return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function _formatDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

// ── Main Resource Manager Panel ───────────────────────────────────────────────

export function buildResourceManagerPanel() {
  // Gather all status data
  const cookieStatus  = getCookiesStatus();
  const allStatuses   = providerHealth.getAllStatuses();
  const qSnap         = getQueueSnapshot();
  const cStats        = getCacheStats();
  const dashboard     = db.getDashboard();
  const workerSnaps   = getAllSnapshots();

  // ── Worker status ──
  const boomboxWorkers = ["youtube", "tiktok", "spotify"];
  const workerLines = boomboxWorkers.map(name => {
    const w = workerSnaps[name];
    if (!w) return `${_indicator(false)} **${name}** — tidak ditemukan`;
    const busy = w.active > 0;
    const icon = w.status === "restarting" ? "🟡"
               : w.active > 0            ? "🟢"
               : "🟢";
    return `${icon} **${name.charAt(0).toUpperCase() + name.slice(1)}** — aktif: ${w.active}/${w.maxConcurrent} | antrean: ${w.queued}`;
  }).join("\n");

  // ── Queue summary ──
  const queueLine = `Aktif: **${qSnap.active}** | Antrean: **${qSnap.queued}** | Max: **${qSnap.maxConcurrent}**`;

  // ── Provider health ──
  const ph = {
    youtube:  allStatuses["yt-dlp (YouTube)"]    ?? null,
    ytdl:     allStatuses["@distube/ytdl-core (Backup API 1)"] ?? null,
    kaizen:   allStatuses["kaizenapi.my.id (Backup API 2)"] ?? null,
    tiktok:   allStatuses["yt-dlp (TikTok)"]     ?? null,
    top4top:  allStatuses["top4top.io (Uploader)"] ?? null,
    spotify:  allStatuses["Spotify oEmbed API"]   ?? null,
  };

  function _provStatus(s) {
    if (!s) return "🔴 Tidak ada data";
    return s.status === "ONLINE"
      ? `🟢 Online (✅ ${s.totalSuccess} | ❌ ${s.totalFailure})`
      : `🔴 Offline (gagal ${s.consecutiveFailures}x)`;
  }

  // ── Cookie status ──
  const cookOk   = cookieStatus.hasCookies;
  const cookLine = cookOk
    ? `🟢 Aktif • ${_formatBytes(cookieStatus.sizeBytes)}` + (cookieStatus.meta?.uploadedAt ? ` • ${_formatDate(cookieStatus.meta.uploadedAt)}` : "")
    : "🔴 Tidak ada cookies";

  // ── GIF status ──
  const gifEnabled = dashboard.showGif;
  const gifCount   = Object.values(dashboard.gifs ?? {}).filter(Boolean).length;
  const gifLine    = gifEnabled
    ? `🟢 Aktif • ${gifCount}/6 GIF dikonfigurasi`
    : gifCount > 0
      ? `🟡 Nonaktif • ${gifCount}/6 GIF dikonfigurasi`
      : "🔴 Nonaktif • Tidak ada GIF";

  // ── DB status ──
  let dbOk = true;
  try { db.getStatistics(); } catch { dbOk = false; }

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🗄️ BoomBox — Resource Manager")
    .setDescription("Status semua resource BoomBox. Gunakan menu di bawah untuk mengelola resource.")
    .addFields(
      {
        name: "⚙️ Worker & Queue",
        value: workerLines + "\n\n" + queueLine,
        inline: false,
      },
      {
        name: "💾 Cache & Database",
        value:
          `${_indicator(dbOk)} Database — ${dbOk ? "🟢 Online" : "🔴 Error"}\n` +
          `🟢 Cache — result: **${cStats.resultSize}** | meta: **${cStats.metaSize}** | hit rate: **${cStats.hitRate}**`,
        inline: false,
      },
      {
        name: "🎵 YouTube",
        value:
          `yt-dlp: ${_provStatus(ph.youtube)}\n` +
          `ytdl-core: ${_provStatus(ph.ytdl)}\n` +
          `Kaizen API: ${_provStatus(ph.kaizen)}`,
        inline: true,
      },
      {
        name: "🎵 TikTok & Spotify",
        value:
          `TikTok: ${_provStatus(ph.tiktok)}\n` +
          `Spotify: ${_provStatus(ph.spotify)}`,
        inline: true,
      },
      {
        name: "📤 Upload & Downloader",
        value: `Top4Top: ${_provStatus(ph.top4top)}`,
        inline: false,
      },
      {
        name: "🍪 YouTube Cookies",
        value: cookLine,
        inline: true,
      },
      {
        name: "🎬 GIF",
        value: gifLine,
        inline: true,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const menuRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("bbrm:menu:select")
      .setPlaceholder("🗄️ Pilih resource...")
      .addOptions([
        { label: "🍪 YouTube Cookies",    value: "cookies",  description: "Upload, ganti, hapus, test dan status cookies" },
        { label: "🎬 Pengaturan GIF",     value: "gif",      description: "Atur GIF per status BoomBox" },
        { label: "📊 Status Lengkap",     value: "status",   description: "Refresh tampilan status resource" },
      ]),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbsetup:back").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("bbsetup:close").setLabel("❌ Tutup").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [menuRow, backRow] };
}

// ── Cookies Panel ─────────────────────────────────────────────────────────────

export function buildCookiesPanel() {
  const st = getCookiesStatus();
  const meta = st.meta;

  let statusLine;
  if (st.hasCookies) {
    statusLine =
      `🟢 **Aktif**\n` +
      `📁 Path: \`${st.path}\`\n` +
      `📦 Ukuran: ${_formatBytes(st.sizeBytes)}\n` +
      (meta?.uploadedAt ? `🕐 Diupload: ${_formatDate(meta.uploadedAt)}\n` : "") +
      (meta?.source === "managed" || st.source === "managed" ? "📌 Source: Upload manual (Resource Manager)" :
       st.source === "env"     ? "📌 Source: Environment variable `YOUTUBE_COOKIES`" :
       "📌 Source: `cookies.txt` (project root)");
  } else {
    statusLine =
      "🔴 **Tidak ada cookies**\n\n" +
      "Tanpa cookies, BoomBox menggunakan fallback chain penuh untuk YouTube.\n" +
      "Cookies membantu bypass anti-bot YouTube.";
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🍪 BoomBox — YouTube Cookies")
    .setDescription(
      "Satu file cookies.txt digunakan oleh **YouTube** dan **Spotify**.\n" +
      "TikTok tidak menggunakan cookies YouTube.\n\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      statusLine
    )
    .addFields({
      name: "ℹ️ Format",
      value:
        "File cookies.txt harus dalam format **Netscape** (diekspor dari browser).\n" +
        "Gunakan ekstensi seperti `EditThisCookie` atau `Get cookies.txt LOCALLY`.",
    })
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbrm:cookies:upload:paste")
      .setLabel("📋 Upload (Paste)")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(false),
    new ButtonBuilder()
      .setCustomId("bbrm:cookies:upload:url")
      .setLabel("🔗 Upload dari URL")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("bbrm:cookies:test")
      .setLabel("🧪 Test Cookies")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!st.hasCookies),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bbrm:cookies:delete")
      .setLabel("🗑️ Hapus Cookies")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!st.hasCookies),
    new ButtonBuilder()
      .setCustomId("bbrm:cookies:panel")
      .setLabel("🔄 Refresh Status")
      .setStyle(ButtonStyle.Secondary),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbrm:resource:panel").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2, backRow] };
}

// ── Cookie Upload Modals ──────────────────────────────────────────────────────

import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

export function buildCookiesPasteModal() {
  const modal = new ModalBuilder()
    .setCustomId("bbrm:cookies:modal:paste")
    .setTitle("Upload Cookies (Paste)");

  const input = new TextInputBuilder()
    .setCustomId("cookies_content")
    .setLabel("Isi file cookies.txt (format Netscape)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setPlaceholder("# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n.youtube.com\tTRUE\t/\t...");

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

export function buildCookiesUrlModal() {
  const modal = new ModalBuilder()
    .setCustomId("bbrm:cookies:modal:url")
    .setTitle("Upload Cookies dari URL");

  const input = new TextInputBuilder()
    .setCustomId("cookies_url")
    .setLabel("URL langsung ke file cookies.txt")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("https://raw.githubusercontent.com/.../cookies.txt");

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

export function buildCookiesDeleteConfirmPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🗑️ Hapus YouTube Cookies")
    .setDescription(
      "⚠️ Yakin ingin menghapus file cookies YouTube?\n\n" +
      "BoomBox akan tetap berfungsi tanpa cookies, namun YouTube mungkin akan lebih mudah mendeteksi bot.\n\n" +
      "Hanya file yang diupload melalui Resource Manager yang akan dihapus. Cookies dari environment variable tidak terpengaruh."
    )
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbrm:cookies:delete:confirm").setLabel("✅ Ya, Hapus").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("bbrm:cookies:panel").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

// ── GIF Panel (redirect to bbdash) ───────────────────────────────────────────

export function buildGifResourcePanel() {
  const d = db.getDashboard();
  const gifCount = Object.values(d.gifs ?? {}).filter(Boolean).length;

  const gifLines = [
    { type: "loading",     label: "⏳ Loading" },
    { type: "success",     label: "✅ Sukses" },
    { type: "cache",       label: "📦 Cache" },
    { type: "error",       label: "❌ Error" },
    { type: "maintenance", label: "🛠 Maintenance" },
    { type: "timeout",     label: "⌛ Timeout" },
  ].map(({ type, label }) => {
    const url = d.gifs?.[type];
    return url ? `${label}: ✅` : `${label}: —`;
  }).join("\n");

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🎬 BoomBox — GIF Resource")
    .setDescription(
      `Status GIF: ${d.showGif ? "🟢 Aktif" : "🔴 Nonaktif"}\n` +
      `Dikonfigurasi: ${gifCount}/6\n\n` +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      gifLines + "\n\n" +
      "GIF disimpan sebagai URL. Gunakan link dari Giphy, Tenor, atau CDN lain.\n" +
      "Jika GIF dinonaktifkan, BoomBox otomatis menggunakan embed biasa."
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(d.showGif ? "bbrm:gif:disable" : "bbrm:gif:enable")
      .setLabel(d.showGif ? "🔴 Nonaktifkan GIF" : "🟢 Aktifkan GIF")
      .setStyle(d.showGif ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("bbrm:gif:manage")
      .setLabel("⚙️ Kelola URL GIF")
      .setStyle(ButtonStyle.Primary),
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bbrm:resource:panel").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, backRow] };
}
