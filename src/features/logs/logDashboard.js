/**
 * boomboxLogDashboard.js — Paginated BoomBox Logs dashboard.
 *
 * Single message, edited in place. 10 entries per page.
 * Navigation row 1: ⏮ First | ◀ Previous | 🔄 Refresh | ▶ Next | ⏭ Last
 * Navigation row 2: 📂 View All Pages
 * Each entry: numbered index, 🎵 Title, 🔗 URL, 🕒 Waktu.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";

import { BOOMBOX_CONFIG }     from "../boombox/config.js";
import { db }                 from "../../database/db.js";
import { LOG_SEP }            from "../boombox/embed.js";
import { logger }             from "../../utils/logger.js";
import { buildPublicLogPanel } from "../boombox/logs/viewer.js";

/** Format an ISO timestamp to WIB (UTC+7) display string. */
function formatWIB(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(wib.getUTCDate())}/${pad(wib.getUTCMonth() + 1)}/${wib.getUTCFullYear()} ${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())} WIB`;
  } catch {
    return "-";
  }
}

const COLOR_LOG        = 0x3ba4ff;
const PAGE_SIZE        = 10;
const DESC_SAFE_LIMIT  = 3900;

export function resolvePage(entries, requestedPage) {
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page       = Math.min(Math.max(1, requestedPage || 1), totalPages);
  const slice      = entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return { totalPages, page, slice };
}

/**
 * Build numbered description for one page.
 * Format per entry:
 *   {n}.
 *   🎵 Title
 *   🔗 URL
 */
function buildPageDescription(slice, pageStartIndex) {
  if (slice.length === 0) {
    return `${LOG_SEP}\n\n_Belum ada data BoomBox._\n\n${LOG_SEP}`;
  }

  const blocks = [];
  for (let i = 0; i < slice.length; i++) {
    const entry = slice[i];
    const n     = pageStartIndex + i;
    // Truncate title at 60 chars to keep description manageable
    const title = (entry.title ?? "Unknown").slice(0, 60);
    blocks.push(`**${n}.**\n🎵 ${title}\n🔗 ${entry.boomboxUrl ?? "-"}\n🕒 ${formatWIB(entry.timestamp)}`);
  }

  let desc = `${LOG_SEP}\n\n${blocks.join(`\n\n${LOG_SEP}\n\n`)}\n\n${LOG_SEP}`;

  // Safety trim: if pathological entry blows past Discord's limit
  while (desc.length > DESC_SAFE_LIMIT && blocks.length > 1) {
    blocks.pop();
    desc = `${LOG_SEP}\n\n${blocks.join(`\n\n${LOG_SEP}\n\n`)}\n\n${LOG_SEP}`;
  }

  return desc;
}

export function buildLogDashboardEmbed(entries, requestedPage = 1) {
  const { totalPages, page, slice } = resolvePage(entries, requestedPage);
  const pageStartIndex = (page - 1) * PAGE_SIZE + 1;

  return new EmbedBuilder()
    .setColor(COLOR_LOG)
    .setTitle("📻 BoomBox Logs")
    .setDescription(buildPageDescription(slice, pageStartIndex))
    .setFooter({
      text: `BoomBox Logs\nHalaman ${page}/${totalPages}\nTotal ${entries.length} Entri`,
    })
    .setTimestamp();
}

// ── Navigation ────────────────────────────────────────────────────────────────
// Row 1: ⏮ First | ◀ Previous | 🔄 Refresh | ▶ Next | ⏭ Last
// Row 2: 📂 View All Pages

function buildNavRows(page, totalPages) {
  const isFirst = page <= 1;
  const isLast  = page >= totalPages;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bblog:nav:first:${page}`)
      .setEmoji("⏮️")
      .setLabel("First")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isFirst),
    new ButtonBuilder()
      .setCustomId(`bblog:nav:prev:${page}`)
      .setEmoji("◀️")
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isFirst),
    new ButtonBuilder()
      .setCustomId(`bblog:nav:refresh:${page}`)
      .setEmoji("🔄")
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bblog:nav:next:${page}`)
      .setEmoji("▶️")
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLast),
    new ButtonBuilder()
      .setCustomId(`bblog:nav:last:${page}`)
      .setEmoji("⏭️")
      .setLabel("Last")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLast),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bblog:viewall:${page}`)
      .setEmoji("📂")
      .setLabel("View All Pages")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(totalPages <= 1),
  );

  return [row1, row2];
}

export function buildLogDashboardComponents(entries, requestedPage = 1) {
  const { totalPages, page } = resolvePage(entries, requestedPage);
  return buildNavRows(page, totalPages);
}

// ── "Semua Halaman" ephemeral — shows page list so user can jump directly ─────

export function buildViewAllEmbed(entries) {
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));

  const lines = Array.from({ length: totalPages }, (_, i) => {
    const count = i < totalPages - 1
      ? PAGE_SIZE
      : entries.length - i * PAGE_SIZE;
    return `📄 Halaman ${i + 1} (${count} Log)`;
  });

  return new EmbedBuilder()
    .setColor(0x3ba4ff)
    .setTitle("📚 BoomBox Logs")
    .setDescription(
      [
        "Pilih Halaman",
        "",
        ...lines,
        "",
        "━━━━━━━━━━",
        "",
        `Total Logs : ${entries.length}`,
      ].join("\n"),
    )
    .setFooter({ text: "Pangeran Assistant AI • BoomBox Logs" });
}

export function buildViewAllSelectRow(totalPages) {
  const options = Array.from({ length: Math.min(totalPages, 25) }, (_, i) => ({
    label: `Halaman ${i + 1}`,
    value: `${i + 1}`,
  }));
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("bblog:pagesel")
        .setPlaceholder("📂 Pilih Halaman")
        .addOptions(options),
    ),
  ];
}

// ── Auto-update dashboard (called after each successful BoomBox) ───────────────

/**
 * Pastikan panel BoomBox Logs V2 (3 button platform) ada di log channel.
 * Dipanggil setiap kali BoomBox berhasil melakukan konversi.
 *
 * Logic:
 *   - Jika messageId tersimpan dan pesan masih ada → edit ke format V2 (idempoten).
 *   - Jika pesan tidak ditemukan → buat baru, simpan messageId baru.
 *   - Panel V2 bersifat statis (3 tombol platform) — user klik untuk buka viewer ephemeral.
 */
export async function updateBoomBoxLogDashboard(client, { resetToFirstPage = true } = {}) {
  try {
    // V2: baca log channel dari DB, fallback ke hardcode jika belum di-setup
    const logChannelId = db.getLogChannel?.() ?? BOOMBOX_CONFIG.BOOMBOX_LOG_CHANNEL_ID;
    if (!logChannelId) {
      logger.warn("[BoomBox] Log channel belum dikonfigurasi. Jalankan /setupboombox untuk mengatur.");
      return;
    }
    const ch = await client.channels.fetch(logChannelId).catch(() => null);
    if (!ch?.isTextBased()) {
      logger.warn(`[BoomBox] Log channel ${logChannelId} not found or not text-based`);
      return;
    }

    // V2: panel statis dengan 3 tombol platform (bukan nav-panel lama)
    const state   = db.getLogState();
    const payload = buildPublicLogPanel();

    if (state.messageId) {
      try {
        const msg = await ch.messages.fetch(state.messageId);
        await msg.edit(payload);
        logger.debug("[BoomBox] Log panel V2 ensured");
        return;
      } catch {
        logger.info("[BoomBox] Previous panel message gone — creating new one");
      }
    }

    const newMsg = await ch.send(payload);
    db.setLogState({ messageId: newMsg.id });
    logger.info(`[BoomBox] BoomBox Logs panel V2 created: ${newMsg.id}`);
  } catch (e) {
    logger.error(`[BoomBox] Failed to update log panel: ${e.message}`);
  }
}
