/**
 * features/database/embed.js — Semua embed builder untuk sistem DATABASE.
 *
 * Fungsi yang diekspor:
 *
 *  Setup flow:
 *    buildSetupMainEmbed()              — menu utama /setup
 *    buildSetupChannelSelectEmbed(sel)  — pilih 4 channel (first-time)
 *    buildSetupSummaryEmbed(sel, guild) — ringkasan sebelum buat panel
 *    buildSetupManageEmbed(setup)       — jika sudah pernah setup
 *
 *  Panel embeds (edit-in-place):
 *    buildBotSettingEmbed(client, setup)         — panel ⚙️ Bot Setting
 *    buildBackupPanelEmbed(lastBackup)           — panel 💾 Backup
 *    buildStorageEmbed(stats)                    — panel 📊 Storage
 *    buildSmartCleanResultEmbed(result)          — hasil Smart Clean
 *    buildSmartCleanDetailEmbed(result)          — detail Smart Clean
 *    buildMemberListEmbed(stats)                 — panel 👥 Member List
 *
 *  Komponen (ActionRow + Button / Select):
 *    buildSetupMainComponents()                  — tombol menu utama
 *    buildSetupChannelSelectComponents(sel)      — 4 ChannelSelect + tombol
 *    buildSetupSummaryComponents()               — ✅ Buat / ✏️ Edit / ❌ Batal
 *    buildSetupManageComponents()                — menu manage existing setup
 *    buildBotSettingComponents()                 — ⚙️ Edit, 🔄 Refresh
 *    buildBackupPanelComponents()                — 💾 Backup, 🔍 Smart Clean, dll
 *    buildSmartCleanResultComponents()           — 📄 Detail, 🧹 Bersihkan, 🔄 Scan Ulang
 *    buildSmartCleanDetailComponents()           — 🧹 Bersihkan, 🔄 Scan Ulang
 *    buildCleanConfirmComponents()               — ✅ Ya, Hapus / ❌ Batal
 *    buildBackupActionComponents(tmpId)          — 📥 Download, ☁ Upload GitHub
 *    buildMemberListComponents()                 — 👥 Lihat, 🔍 Cari, 📤 Export, 🔄 Refresh
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
} from "discord.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.join(__dirname, "..", "..", "..");

// ── Konstanta ─────────────────────────────────────────────────────────────────

const FOOTER = "Pangeran Assistant AI • Database";
const COLOR  = {
  BLUE:   0x5865f2,
  GREEN:  0x57f287,
  YELLOW: 0xfee75c,
  RED:    0xed4245,
  GRAY:   0x2f3136,
};

/** Format uptime dari millisecond menjadi string yang mudah dibaca. */
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}h ${h % 24}j ${m % 60}m`;
  if (h > 0) return `${h}j ${m % 60}m ${s % 60}d`;
  return `${m}m ${s % 60}d`;
}

// ── Setup: Menu Utama ─────────────────────────────────────────────────────────

/** Embed menu utama /setup. */
export function buildSetupMainEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("⚙️ Panel Admin — Setup")
    .setDescription(
      "Pilih sistem yang ingin kamu konfigurasi.\n\n" +
      "**📊 Database** — Setup channel Database (Bot Setting, Backup, Console, Member List)",
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/** Tombol menu utama /setup. */
export function buildSetupMainComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:setup:open").setLabel("📊 Database").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:setup:close").setLabel("❌ Tutup").setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Setup: Pilih Channel (First-time) ─────────────────────────────────────────

/**
 * Embed saat memilih channel untuk pertama kali.
 * @param {{ botSetting?: string, backup?: string, console?: string, memberList?: string }} selections
 */
export function buildSetupChannelSelectEmbed(selections = {}) {
  const check = (id) => (id ? `<#${id}> ✅` : "Belum dipilih");

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📊 Setup Database — Pilih Channel")
    .setDescription(
      "Pilih channel untuk setiap panel Database menggunakan menu di bawah.\n\n" +
      "Setelah semua channel dipilih, klik **✅ Buat Panel**.\n",
    )
    .addFields(
      { name: "⚙️ Bot Setting",  value: check(selections.botSetting),  inline: true },
      { name: "📦 Backup",       value: check(selections.backup),       inline: true },
      { name: "📄 Console",      value: check(selections.console),      inline: true },
      { name: "👥 Member List",  value: check(selections.memberList),   inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/**
 * Komponen 4 ChannelSelectMenu + tombol Buat Panel dan Batal.
 * @param {{ botSetting?: string, backup?: string, console?: string, memberList?: string }} selections
 */
export function buildSetupChannelSelectComponents(selections = {}) {
  const allSelected = selections.botSetting && selections.backup && selections.console && selections.memberList;

  return [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("db:select:botSetting")
        .setPlaceholder("⚙️ Pilih channel Bot Setting")
        .addChannelTypes(ChannelType.GuildText)
        .setMinValues(1).setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("db:select:backup")
        .setPlaceholder("📦 Pilih channel Backup")
        .addChannelTypes(ChannelType.GuildText)
        .setMinValues(1).setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("db:select:console")
        .setPlaceholder("📄 Pilih channel Console")
        .addChannelTypes(ChannelType.GuildText)
        .setMinValues(1).setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("db:select:memberList")
        .setPlaceholder("👥 Pilih channel Member List")
        .addChannelTypes(ChannelType.GuildText)
        .setMinValues(1).setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("db:setup:create")
        .setLabel("✅ Buat Panel")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!allSelected),
      new ButtonBuilder()
        .setCustomId("db:setup:cancel")
        .setLabel("❌ Batal")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Setup: Ringkasan sebelum Buat Panel ───────────────────────────────────────

/**
 * Embed ringkasan channel yang dipilih sebelum membuat panel.
 * @param {{ botSetting: string, backup: string, console: string, memberList: string }} selections
 */
export function buildSetupSummaryEmbed(selections) {
  return new EmbedBuilder()
    .setColor(COLOR.GREEN)
    .setTitle("📊 Konfirmasi Setup Database")
    .setDescription(
      "Berikut channel yang akan digunakan untuk setiap panel.\n" +
      "Klik **✅ Buat Panel** untuk melanjutkan.\n",
    )
    .addFields(
      { name: "⚙️ Bot Setting", value: `<#${selections.botSetting}>`, inline: true },
      { name: "📦 Backup",      value: `<#${selections.backup}>`,      inline: true },
      { name: "📄 Console",     value: `<#${selections.console}>`,     inline: true },
      { name: "👥 Member List", value: `<#${selections.memberList}>`,  inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/** Tombol ✅ Buat Panel / ✏️ Edit / ❌ Batal. */
export function buildSetupSummaryComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:setup:create").setLabel("✅ Buat Panel").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("db:setup:edit").setLabel("✏️ Edit").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("db:setup:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Setup: Manage (sudah pernah setup) ───────────────────────────────────────

/**
 * Embed untuk manage setup yang sudah ada.
 * @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup
 */
export function buildSetupManageEmbed(setup) {
  const ch = setup.channels;
  const ms = setup.messages;

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📊 Database — Setup Sudah Ada")
    .setDescription("Database sudah pernah dikonfigurasi. Pilih tindakan di bawah.")
    .addFields(
      { name: "⚙️ Bot Setting",  value: ch.botSetting  ? `<#${ch.botSetting}>`  : "—", inline: true },
      { name: "📦 Backup",       value: ch.backup       ? `<#${ch.backup}>`       : "—", inline: true },
      { name: "📄 Console",      value: ch.console      ? `<#${ch.console}>`      : "—", inline: true },
      { name: "👥 Member List",  value: ch.memberList   ? `<#${ch.memberList}>`   : "—", inline: true },
      {
        name: "📌 Status Panel",
        value: [
          `Bot Setting: ${ms.botSetting  ? "✅ Ada" : "❌ Belum dibuat"}`,
          `Backup:      ${ms.backup      ? "✅ Ada" : "❌ Belum dibuat"}`,
          `Member List: ${ms.memberList  ? "✅ Ada" : "❌ Belum dibuat"}`,
        ].join("\n"),
        inline: false,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/** Tombol manage setup yang sudah ada. */
export function buildSetupManageComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:setup:edit").setLabel("📝 Edit Setup").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:setup:rebuild").setLabel("🔄 Buat Ulang Panel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("db:setup:delete").setLabel("🗑 Hapus Panel").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("db:setup:close").setLabel("❌ Tutup").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Panel: Bot Setting ────────────────────────────────────────────────────────

/**
 * Embed panel ⚙️ Bot Setting.
 * @param {import("discord.js").Client} client
 * @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup
 */
export function buildBotSettingEmbed(client, setup) {
  const uptimeMs = client.uptime ?? 0;
  const version  = _readVersion();
  const dbSize   = _readDataDirSize();
  const githubRepo = process.env.GITHUB_REPO || setup.github?.repo || "Belum dikonfigurasi";
  const githubToken = process.env.GITHUB_TOKEN ? "✅ Dikonfigurasi" : "❌ Belum ada";

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("⚙️ Bot Setting")
    .setDescription("Konfigurasi dan status sistem bot secara real-time.")
    .addFields(
      { name: "🤖 Bot",         value: client.user?.tag ?? "—",                  inline: true  },
      { name: "📦 Versi",       value: `v${version}`,                             inline: true  },
      { name: "⏱ Uptime",       value: formatUptime(uptimeMs),                    inline: true  },
      { name: "💾 Database",    value: dbSize,                                     inline: true  },
      { name: "🐙 GitHub Repo", value: `\`${githubRepo}\``,                        inline: true  },
      { name: "🔑 GitHub Token",value: githubToken,                               inline: true  },
      { name: "🔄 Auto Backup", value: setup.autoBackup  ? "✅ Aktif" : "❌ Nonaktif", inline: true },
      { name: "🧹 Auto Clean",  value: setup.autoClean   ? "✅ Aktif" : "❌ Nonaktif", inline: true },
      {
        name: "📌 Dibuat",
        value: setup.createdAt
          ? new Date(setup.createdAt).toLocaleString("id-ID")
          : "—",
        inline: false,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/** Tombol panel Bot Setting. */
export function buildBotSettingComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:setting:edit").setLabel("⚙️ Edit").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:panel:setting:refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Panel: Backup ─────────────────────────────────────────────────────────────

/**
 * Embed panel 💾 Backup.
 * @param {{ lastAt?: string, lastName?: string, lastSize?: string }|null} lastBackup
 */
export function buildBackupPanelEmbed(lastBackup = null) {
  const lastInfo = lastBackup?.lastAt
    ? `${lastBackup.lastName ?? "backup.zip"}\n${lastBackup.lastSize ?? ""} • ${new Date(lastBackup.lastAt).toLocaleString("id-ID")}`
    : "Belum ada backup";

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📦 Backup Panel")
    .setDescription(
      "Buat backup database dan data penting bot.\n\n" +
      "Backup berisi: database, config, assets, logs, session, plugins.\n" +
      "Tidak termasuk: node_modules, cache, temp, file sampah.",
    )
    .addFields(
      { name: "💾 Backup Terakhir", value: lastInfo, inline: false },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/** Tombol panel Backup. */
export function buildBackupPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:backup:backup").setLabel("💾 Backup").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("db:panel:backup:smartclean").setLabel("🔍 Smart Clean").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:panel:backup:storage").setLabel("📊 Storage").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("db:panel:backup:refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Panel: Storage ────────────────────────────────────────────────────────────

/**
 * Embed panel 📊 Storage.
 * @param {ReturnType<import("./backup.js").getStorageStats>} stats
 */
export function buildStorageEmbed(stats) {
  const s = stats.strings;

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📊 Storage — Penggunaan Penyimpanan")
    .addFields(
      { name: "💾 Database",  value: s.database, inline: true },
      { name: "🗃 Cache",     value: s.cache,    inline: true },
      { name: "📁 Temp",      value: s.temp,     inline: true },
      { name: "📦 Backup",    value: s.backup,   inline: true },
      { name: "🖼 Assets",    value: s.assets,   inline: true },
      { name: "📋 Logs",      value: s.logs,     inline: true },
      { name: "📝 Source",    value: s.source,   inline: true },
      { name: "📊 Total",     value: `**${s.total}**`,  inline: true },
      { name: "💽 Disk Total", value: s.diskTotal, inline: true },
      { name: "💿 Sisa Disk", value: s.diskFree,  inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

// ── Panel: Smart Clean ────────────────────────────────────────────────────────

/**
 * Embed hasil Smart Clean.
 * @param {ReturnType<import("./backup.js").runSmartClean>} result
 */
export function buildSmartCleanResultEmbed(result) {
  const safeCount    = result.safe.length;
  const reviewCount  = result.review.length;
  const protCount    = result.protected.length;

  return new EmbedBuilder()
    .setColor(COLOR.YELLOW)
    .setTitle("🔍 Smart Clean — Hasil Pemindaian")
    .setDescription(
      `Pemindaian selesai pada **${new Date(result.scannedAt).toLocaleString("id-ID")}**\n\n` +
      `Total yang bisa dibersihkan: **${safeCount} item** (${result.totalSafeSizeStr})`,
    )
    .addFields(
      {
        name: "🟢 Aman Dibersihkan",
        value: safeCount > 0
          ? `**${safeCount} item** — ${result.totalSafeSizeStr}\n${result.safe.slice(0, 5).map((f) => `\`${f.rel.slice(0, 50)}\``).join("\n")}${safeCount > 5 ? `\n... dan ${safeCount - 5} lainnya` : ""}`
          : "Tidak ada file yang perlu dibersihkan.",
        inline: false,
      },
      {
        name: "🟡 Perlu Ditinjau",
        value: reviewCount > 0
          ? `**${reviewCount} item**\n${result.review.slice(0, 3).map((f) => `\`${f.rel.slice(0, 50)}\``).join("\n")}${reviewCount > 3 ? `\n... dan ${reviewCount - 3} lainnya` : ""}`
          : "Tidak ada.",
        inline: false,
      },
      {
        name: "🔴 File Penting",
        value: `**${protCount} item** dilindungi — tidak akan dihapus.`,
        inline: false,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/** Tombol hasil Smart Clean. */
export function buildSmartCleanResultComponents(safeCount = 0) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:clean:detail").setLabel("📄 Detail").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("db:panel:clean:clean")
        .setLabel("🧹 Bersihkan")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(safeCount === 0),
      new ButtonBuilder().setCustomId("db:panel:clean:rescan").setLabel("🔄 Scan Ulang").setStyle(ButtonStyle.Primary),
    ),
  ];
}

/**
 * Embed detail Smart Clean (setiap file + alasan).
 * @param {ReturnType<import("./backup.js").runSmartClean>} result
 */
export function buildSmartCleanDetailEmbed(result) {
  // Gabungkan safe + review untuk tampilan detail
  const allReview = [...result.safe, ...result.review].slice(0, 20); // Discord embed limit

  const lines = allReview.map((f) => {
    const cat    = result.safe.includes(f) ? "🟢" : "🟡";
    const label  = f.rel.slice(0, 60);
    const reason = f.reason.slice(0, 100);
    return `${cat} \`${label}\`\n↳ *${reason}*`;
  });

  const desc = lines.length > 0
    ? lines.join("\n\n")
    : "Tidak ada file dalam kategori ini.";

  return new EmbedBuilder()
    .setColor(COLOR.YELLOW)
    .setTitle("📄 Smart Clean — Detail File")
    .setDescription(desc.slice(0, 4000))
    .addFields(
      {
        name: "📌 Catatan",
        value: "File bertanda 🟡 **Perlu Ditinjau** tidak akan ikut dibersihkan.\nHanya file 🟢 **Aman** yang dihapus saat klik Bersihkan.",
        inline: false,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/** Tombol setelah melihat detail Smart Clean. */
export function buildSmartCleanDetailComponents(safeCount = 0) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("db:panel:clean:clean")
        .setLabel("🧹 Bersihkan")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(safeCount === 0),
      new ButtonBuilder().setCustomId("db:panel:clean:rescan").setLabel("🔄 Scan Ulang").setStyle(ButtonStyle.Primary),
    ),
  ];
}

/** Tombol konfirmasi penghapusan Smart Clean. */
export function buildCleanConfirmComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:clean:confirmyes").setLabel("✅ Ya, Hapus").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("db:panel:clean:confirmno").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * Tombol setelah backup selesai — Download dan Upload GitHub.
 * @param {string} tmpId
 */
export function buildBackupActionComponents(tmpId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`db:panel:backup:download:${tmpId}`).setLabel("📥 Download").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`db:panel:backup:upload:${tmpId}`).setLabel("☁ Upload GitHub").setStyle(ButtonStyle.Primary),
    ),
  ];
}

// ── Panel: Member List ────────────────────────────────────────────────────────

/**
 * Embed panel 👥 Member List.
 * @param {{ total: number, premium: number, ceo: number, blacklist: number, activeToday: number }} stats
 */
export function buildMemberListEmbed(stats) {
  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("👥 Member List")
    .setDescription("Statistik anggota server secara real-time.")
    .addFields(
      { name: "👥 Total Member",       value: `**${stats.total}**`,       inline: true },
      { name: "👑 Premium",            value: `**${stats.premium}**`,      inline: true },
      { name: "🔱 CEO",                value: `**${stats.ceo}**`,          inline: true },
      { name: "🚫 Blacklist",          value: `**${stats.blacklist}**`,    inline: true },
      { name: "✅ Aktif Hari Ini",     value: `**${stats.activeToday}**`,  inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/** Tombol panel Member List. */
export function buildMemberListComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:member:view").setLabel("👥 Lihat").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:panel:member:search").setLabel("🔍 Cari").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("db:panel:member:export").setLabel("📤 Export").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("db:panel:member:refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Helper internal ───────────────────────────────────────────────────────────

/** Baca versi dari package.json. */
function _readVersion() {
  try {
    const raw = fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8");
    return JSON.parse(raw).version ?? "2.0.0";
  } catch { return "2.0.0"; }
}

/** Hitung ukuran folder data/ dengan format string yang mudah dibaca. */
function _readDataDirSize() {
  try {
    const dir = path.join(ROOT_DIR, "data");
    if (!fs.existsSync(dir)) return "0 KB";
    let total = 0;
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch { /* skip */ }
    }
    if (total < 1024)       return `${total} B`;
    if (total < 1024*1024)  return `${(total / 1024).toFixed(1)} KB`;
    return `${(total / (1024*1024)).toFixed(2)} MB`;
  } catch { return "N/A"; }
}
