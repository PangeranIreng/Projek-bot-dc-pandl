/**
 * boombox/logs/viewer.js — BoomBox Logs Viewer V2.
 *
 * PANEL PUBLIK (di log channel):
 *   Embed "📼 BoomBox Logs" + 3 tombol platform (bblog:v:open:*)
 *   Satu pesan permanen, di-edit bukan dibuat ulang.
 *
 * VIEWER (ephemeral per-user):
 *   Dibuka saat button platform ditekan. Masing-masing user
 *   punya viewer sendiri — tidak mempengaruhi viewer user lain.
 *   State tersimpan sepenuhnya di customId — tanpa state global.
 *
 * History lama (tanpa field platform) dianggap otomatis sebagai YouTube.
 * Ini ditangani di db.getHistoryByPlatform("YouTube").
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { db } from "../../../database/db.js";

const PAGE_SIZE   = 5;
const COLOR_LOG   = 0x3ba4ff;
const FOOTER_TEXT = "ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴘᴀɴɢᴇʀᴀɴ ᴀꜱꜱɪꜱᴛᴀɴᴛ";
const SEP         = "━━━━━━━━━━━━━━━━━━";

const PLATFORMS = {
  YouTube: { emoji: "🔴", label: "YouTube", style: ButtonStyle.Danger },
  TikTok:  { emoji: "🎶", label: "TikTok",  style: ButtonStyle.Secondary },
  Spotify: { emoji: "🎧", label: "Spotify", style: ButtonStyle.Success },
};

// Circled number ①–⑩ untuk penomoran entry
const CIRCLED = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩"];
function circled(n) {
  return n <= 10 ? CIRCLED[n - 1] : `${n}.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatWIB(iso) {
  if (!iso) return "-";
  try {
    const d   = new Date(iso);
    const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
    const p   = (n) => String(n).padStart(2, "0");
    return `${p(wib.getUTCDate())}/${p(wib.getUTCMonth() + 1)}/${wib.getUTCFullYear()} • ${p(wib.getUTCHours())}:${p(wib.getUTCMinutes())} WIB`;
  } catch { return "-"; }
}

function resolvePage(totalEntries, requestedPage) {
  const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));
  const page       = Math.min(Math.max(1, requestedPage || 1), totalPages);
  return { totalPages, page };
}

// ── Panel publik (satu pesan permanen di log channel) ─────────────────────────

/**
 * Build embed + components untuk panel publik BoomBox Logs.
 * Ini yang di-post/edit di log channel. Isinya statis (3 button platform).
 */
export function buildPublicLogPanel() {
  const embed = new EmbedBuilder()
    .setColor(COLOR_LOG)
    .setTitle("📼 BoomBox Logs")
    .setDescription("Pilih platform untuk melihat riwayat BoomBox.")
    .setFooter({ text: FOOTER_TEXT });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bblog:v:open:YouTube")
      .setLabel("YouTube")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("bblog:v:open:TikTok")
      .setLabel("TikTok")
      .setEmoji("🎶")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bblog:v:open:Spotify")
      .setLabel("Spotify")
      .setEmoji("🎧")
      .setStyle(ButtonStyle.Success),
  );

  return { content: "", embeds: [embed], components: [row] };
}

// ── Viewer (ephemeral per-user) ───────────────────────────────────────────────

/**
 * Build embed + components untuk log viewer per platform.
 * @param {"YouTube"|"TikTok"|"Spotify"} platform
 * @param {number} requestedPage
 */
export function buildLogViewerPanel(platform, requestedPage = 1) {
  const { emoji, label } = PLATFORMS[platform] ?? { emoji: "🎵", label: platform };
  const allEntries       = db.getHistoryByPlatform(platform); // newest-first; YouTube includes legacy
  const { totalPages, page } = resolvePage(allEntries.length, requestedPage);
  const slice            = allEntries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Description
  let descBody;
  if (slice.length === 0) {
    descBody = `\n_Belum ada log ${label}._\n`;
  } else {
    const globalStart = (page - 1) * PAGE_SIZE + 1;
    const blocks = slice.map((entry, i) => {
      const n     = globalStart + i;
      const title = (entry.title ?? "Unknown").slice(0, 60);
      const url   = entry.boomboxUrl ?? "-";
      const time  = formatWIB(entry.timestamp);
      return `${circled(n)} 🎵 ${title}\n🔗 ${url}\n🕒 ${time}`;
    });
    descBody = "\n" + blocks.join(`\n${SEP}\n`) + "\n";
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR_LOG)
    .setTitle("📼 BoomBox Logs")
    .setDescription(`${emoji} **${label}** • Page ${page}/${totalPages}\n${SEP}${descBody}${SEP}`)
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();

  // ── Nav buttons ───────────────────────────────────────────────────────────
  const isFirst = page <= 1;
  const isLast  = page >= totalPages;

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bblog:v:nav:first:${platform}:${page}`)
      .setEmoji("⏮️").setLabel("First")
      .setStyle(ButtonStyle.Secondary).setDisabled(isFirst),
    new ButtonBuilder()
      .setCustomId(`bblog:v:nav:prev:${platform}:${page}`)
      .setEmoji("◀️").setLabel("Prev")
      .setStyle(ButtonStyle.Secondary).setDisabled(isFirst),
    new ButtonBuilder()
      .setCustomId(`bblog:v:nav:refresh:${platform}:${page}`)
      .setEmoji("🔄").setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bblog:v:nav:next:${platform}:${page}`)
      .setEmoji("▶️").setLabel("Next")
      .setStyle(ButtonStyle.Secondary).setDisabled(isLast),
    new ButtonBuilder()
      .setCustomId(`bblog:v:nav:last:${platform}:${page}`)
      .setEmoji("⏭️").setLabel("Last")
      .setStyle(ButtonStyle.Secondary).setDisabled(isLast),
  );

  // ── Page dropdown ─────────────────────────────────────────────────────────
  const pageOptions = Array.from({ length: Math.min(totalPages, 25) }, (_, i) => ({
    label:   `Halaman ${i + 1}`,
    value:   `${i + 1}`,
    default: i + 1 === page,
  }));

  const pageRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`bblog:v:pagesel:${platform}`)
      .setPlaceholder("📄 Pilih Halaman")
      .addOptions(pageOptions),
  );

  // ── Platform dropdown ─────────────────────────────────────────────────────
  const platOptions = Object.entries(PLATFORMS).map(([key, { emoji: e, label: l }]) => ({
    label:   l,
    value:   key,
    emoji:   e,
    default: key === platform,
  }));

  const platRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("bblog:v:platsel")
      .setPlaceholder("🎵 Ganti Platform")
      .addOptions(platOptions),
  );

  return { embeds: [embed], components: [navRow, pageRow, platRow] };
}

// ── Interaction Handler ───────────────────────────────────────────────────────

/**
 * Route semua bblog:v: interactions.
 * @param {import("discord.js").Interaction} interaction
 */
export async function handleLogViewerInteraction(interaction) {
  const id = interaction.customId ?? "";

  // ── Panel publik button: bblog:v:open:<platform> ──────────────────────────
  // Buka viewer ephemeral khusus untuk user yang menekan tombol ini.
  // Tidak mempengaruhi viewer user lain.
  const openBtn = /^bblog:v:open:(YouTube|TikTok|Spotify)$/.exec(id);
  if (openBtn) {
    const platform = openBtn[1];
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply(buildLogViewerPanel(platform, 1));
    return;
  }

  // ── Nav buttons (di dalam ephemeral viewer): bblog:v:nav:<action>:<platform>:<curPage>
  const navBtn = /^bblog:v:nav:(first|prev|refresh|next|last):(YouTube|TikTok|Spotify):(\d+)$/.exec(id);
  if (navBtn) {
    const [, action, platform, curPageStr] = navBtn;
    const curPage = Number(curPageStr);
    const entries = db.getHistoryByPlatform(platform);
    const { totalPages } = resolvePage(entries.length, curPage);

    let page = curPage;
    if      (action === "first")  page = 1;
    else if (action === "prev")   page = Math.max(1, curPage - 1);
    else if (action === "next")   page = Math.min(totalPages, curPage + 1);
    else if (action === "last")   page = totalPages;
    // "refresh" → page = curPage (tidak berubah)

    await interaction.update(buildLogViewerPanel(platform, page));
    return;
  }

  // ── Page dropdown: bblog:v:pagesel:<platform> ─────────────────────────────
  const pageSelMatch = /^bblog:v:pagesel:(YouTube|TikTok|Spotify)$/.exec(id);
  if (pageSelMatch && interaction.isStringSelectMenu()) {
    const platform = pageSelMatch[1];
    const page     = Number(interaction.values[0]);
    await interaction.update(buildLogViewerPanel(platform, page));
    return;
  }

  // ── Platform dropdown: bblog:v:platsel ───────────────────────────────────
  if (id === "bblog:v:platsel" && interaction.isStringSelectMenu()) {
    const platform = interaction.values[0];
    await interaction.update(buildLogViewerPanel(platform, 1));
    return;
  }
}
