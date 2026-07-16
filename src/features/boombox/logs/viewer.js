/**
 * boombox/logs/viewer.js — BoomBox Logs Viewer V2.
 *
 * Membaca langsung dari history[] (tidak dari logState.entries),
 * filter berdasarkan platform. Backward compatible — semua log lama
 * (YouTube) otomatis terbaca tanpa perlu migrasi data.
 *
 * Alur:
 *   [1] Tampilkan pilih platform (YouTube / TikTok / Spotify)
 *   [2] Filter history[] by platform → tampilkan 5 per halaman
 *   [3] Navigasi: First | Prev | Refresh | Next | Last
 *   [4] Dropdown: Pilih Halaman
 *   [5] Dropdown: Ganti Platform
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
const FOOTER_TEXT = "BoomBox V2 • Logs Viewer";
const SEP         = "━━━━━━━━━━━━━━━━━━";

const PLATFORMS = {
  YouTube: { emoji: "📺", label: "YouTube" },
  TikTok:  { emoji: "🎵", label: "TikTok"  },
  Spotify: { emoji: "🎧", label: "Spotify" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatWIB(iso) {
  if (!iso) return "-";
  try {
    const d   = new Date(iso);
    const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
    const p   = (n) => String(n).padStart(2, "0");
    return `${p(wib.getUTCDate())}/${p(wib.getUTCMonth() + 1)}/${wib.getUTCFullYear()} ${p(wib.getUTCHours())}:${p(wib.getUTCMinutes())} WIB`;
  } catch { return "-"; }
}

function resolvePage(totalEntries, requestedPage) {
  const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));
  const page       = Math.min(Math.max(1, requestedPage || 1), totalPages);
  return { totalPages, page };
}

// ── Platform Selector ─────────────────────────────────────────────────────────

export function buildPlatformSelectorPanel() {
  const history = db.getHistoryByPlatform(null);
  const counts  = {
    YouTube: history.filter(e => e.platform === "YouTube").length,
    TikTok:  history.filter(e => e.platform === "TikTok").length,
    Spotify: history.filter(e => e.platform === "Spotify").length,
  };

  const embed = new EmbedBuilder()
    .setColor(COLOR_LOG)
    .setTitle("📻 BoomBox Logs")
    .setDescription(
      SEP + "\n\n" +
      "Pilih platform untuk melihat log.\n\n" +
      `📺 **YouTube**: ${counts.YouTube} log\n` +
      `🎵 **TikTok**: ${counts.TikTok} log\n` +
      `🎧 **Spotify**: ${counts.Spotify} log\n\n` +
      SEP
    )
    .setFooter({ text: FOOTER_TEXT });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bblog:v:platform:YouTube")
      .setLabel("YouTube")
      .setEmoji("📺")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bblog:v:platform:TikTok")
      .setLabel("TikTok")
      .setEmoji("🎵")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bblog:v:platform:Spotify")
      .setLabel("Spotify")
      .setEmoji("🎧")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

// ── Log Viewer (per platform, paginated) ─────────────────────────────────────

/**
 * Build embed + components for a paginated platform log view.
 * @param {"YouTube"|"TikTok"|"Spotify"} platform
 * @param {number} requestedPage
 * @returns {{ embed: EmbedBuilder, components: ActionRowBuilder[] }}
 */
export function buildLogViewerPanel(platform, requestedPage = 1) {
  const { emoji, label } = PLATFORMS[platform] ?? { emoji: "🎵", label: platform };
  const allEntries       = db.getHistoryByPlatform(platform); // newest-first
  const { totalPages, page } = resolvePage(allEntries.length, requestedPage);

  const slice = allEntries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Build description
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
      return `**${n}.** ${title}\n🔗 ${url}\n🕒 ${time}`;
    });
    descBody = "\n" + blocks.join(`\n${SEP}\n`) + "\n";
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR_LOG)
    .setTitle(`${emoji} Logs BoomBox ${label}`)
    .setDescription(SEP + descBody + SEP)
    .setFooter({
      text: `${FOOTER_TEXT} | Halaman ${page}/${totalPages} | Total ${allEntries.length} log`,
    })
    .setTimestamp();

  // ── Navigation Row ──────────────────────────────────────────────────────
  const isFirst = page <= 1;
  const isLast  = page >= totalPages;

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bblog:v:nav:first:${platform}:${page}`)
      .setEmoji("⏮️")
      .setLabel("First")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isFirst),
    new ButtonBuilder()
      .setCustomId(`bblog:v:nav:prev:${platform}:${page}`)
      .setEmoji("◀️")
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isFirst),
    new ButtonBuilder()
      .setCustomId(`bblog:v:nav:refresh:${platform}:${page}`)
      .setEmoji("🔄")
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bblog:v:nav:next:${platform}:${page}`)
      .setEmoji("▶️")
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLast),
    new ButtonBuilder()
      .setCustomId(`bblog:v:nav:last:${platform}:${page}`)
      .setEmoji("⏭️")
      .setLabel("Last")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLast),
  );

  // ── Page Dropdown ───────────────────────────────────────────────────────
  const pageOptions = Array.from({ length: Math.min(totalPages, 25) }, (_, i) => ({
    label:       `Halaman ${i + 1}`,
    value:       `${i + 1}`,
    description: `${Math.min((i + 1) * PAGE_SIZE, allEntries.length) - i * PAGE_SIZE} log`,
    default:     i + 1 === page,
  }));

  const pageRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`bblog:v:pagesel:${platform}`)
      .setPlaceholder("📄 Pilih Halaman")
      .addOptions(pageOptions),
  );

  // ── Platform Dropdown ───────────────────────────────────────────────────
  const platOptions = Object.entries(PLATFORMS).map(([key, { emoji: e, label: l }]) => ({
    label:   `${l}`,
    value:   key,
    emoji:   e,
    default: key === platform,
  }));

  const platRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("bblog:v:platsel")
      .setPlaceholder("🔄 Ganti Platform")
      .addOptions(platOptions),
  );

  return { embed, components: [navRow, pageRow, platRow] };
}

// ── Interaction Handler ───────────────────────────────────────────────────────

/**
 * Route all bblog:v: interactions to the correct handler.
 * @param {import("discord.js").Interaction} interaction
 */
export async function handleLogViewerInteraction(interaction) {
  const id = interaction.customId ?? "";

  // Platform selector buttons: bblog:v:platform:<platform>
  const platBtn = /^bblog:v:platform:(YouTube|TikTok|Spotify)$/.exec(id);
  if (platBtn) {
    const platform = platBtn[1];
    const { embed, components } = buildLogViewerPanel(platform, 1);
    if (interaction.isButton()) {
      await interaction.update({ embeds: [embed], components });
    } else {
      await interaction.reply({ embeds: [embed], components, ephemeral: true });
    }
    return;
  }

  // Nav buttons: bblog:v:nav:<action>:<platform>:<curPage>
  const navBtn = /^bblog:v:nav:(first|prev|refresh|next|last):(YouTube|TikTok|Spotify):(\d+)$/.exec(id);
  if (navBtn) {
    const [, action, platform, curPageStr] = navBtn;
    const curPage  = Number(curPageStr);
    const entries  = db.getHistoryByPlatform(platform);
    const { totalPages } = resolvePage(entries.length, curPage);

    let page = curPage;
    if (action === "first")      page = 1;
    else if (action === "prev")  page = Math.max(1, curPage - 1);
    else if (action === "next")  page = Math.min(totalPages, curPage + 1);
    else if (action === "last")  page = totalPages;
    // "refresh" keeps current page

    const { embed, components } = buildLogViewerPanel(platform, page);
    await interaction.update({ embeds: [embed], components });
    return;
  }

  // Page select: bblog:v:pagesel:<platform>
  const pageSelMatch = /^bblog:v:pagesel:(YouTube|TikTok|Spotify)$/.exec(id);
  if (pageSelMatch && interaction.isStringSelectMenu()) {
    const platform = pageSelMatch[1];
    const page     = Number(interaction.values[0]);
    const { embed, components } = buildLogViewerPanel(platform, page);
    await interaction.update({ embeds: [embed], components });
    return;
  }

  // Platform change select: bblog:v:platsel
  if (id === "bblog:v:platsel" && interaction.isStringSelectMenu()) {
    const platform = interaction.values[0];
    const { embed, components } = buildLogViewerPanel(platform, 1);
    await interaction.update({ embeds: [embed], components });
    return;
  }
}
