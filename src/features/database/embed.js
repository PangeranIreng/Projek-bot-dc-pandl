/**
 * features/database/embed.js — Semua embed + komponen untuk sistem DATABASE.
 *
 * Setup flow:
 *   buildSetupMainEmbed/Components()            — menu utama /setup
 *   buildSetupWizardEmbed/Components()           — wizard: Pilih Kategori vs Buat Baru
 *   buildCategorySelectEmbed/Components(catId)   — pilih kategori yang sudah ada
 *   buildSetupSuccessEmbed/Components(...)        — setelah setup berhasil
 *   buildSetupManageEmbed/Components(setup)       — jika sudah pernah setup
 *   buildResetConfirmEmbed/Components()           — konfirmasi reset
 *   buildGitHubManagerEmbed/Components(setup)     — manajemen GitHub
 *
 * Panel embeds (edit-in-place):
 *   buildBotSettingEmbed(client, setup)
 *   buildBackupPanelEmbed(lastBackup?)
 *   buildStorageEmbed(stats)
 *   buildSmartCleanResultEmbed/Components(result)
 *   buildSmartCleanDetailEmbed/Components(result)
 *   buildCleanConfirmComponents()
 *   buildBackupActionComponents(tmpId)
 *   buildMemberListEmbed/Components(stats)
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
} from "discord.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.join(__dirname, "..", "..", "..");

const FOOTER = "Pangeran Assistant AI • Database";
const COLOR  = {
  BLUE:   0x5865f2,
  GREEN:  0x57f287,
  YELLOW: 0xfee75c,
  RED:    0xed4245,
  GRAY:   0x2f3136,
};

/** Konversi bytes ke string yang mudah dibaca. Diperlukan untuk buildStorageEmbed. */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}h ${h % 24}j ${m % 60}m`;
  if (h > 0) return `${h}j ${m % 60}m ${s % 60}d`;
  return `${m}m ${s % 60}d`;
}

// ════════════════════════════════════════════════════════════════════════════
// SETUP FLOW
// ════════════════════════════════════════════════════════════════════════════

// ── Menu Utama /setup ─────────────────────────────────────────────────────────

export function buildSetupMainEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("⚙️ Panel Admin")
    .setDescription("Pilih sistem yang ingin dikonfigurasi.")
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildSetupMainComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:setup:open").setLabel("📊 Database").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:setup:close").setLabel("❌ Tutup").setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Wizard: Pilih Kategori vs Buat Baru ──────────────────────────────────────

export function buildSetupWizardEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📊 Setup Database")
    .setDescription(
      "Pilih lokasi panel Database.\n\n" +
      "**📂 Pilih Kategori** — Gunakan kategori yang sudah ada\n" +
      "**📂 Buat Kategori Baru** — Buat kategori baru secara otomatis",
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildSetupWizardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("db:setup:wizard:existing")
        .setLabel("📂 Pilih Kategori")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("db:setup:wizard:new")
        .setLabel("📂 Buat Kategori Baru")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("db:setup:cancel")
        .setLabel("❌ Batal")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Pilih Kategori yang Sudah Ada ─────────────────────────────────────────────

/**
 * @param {string|null} selectedCategoryId
 * @param {string|null} selectedCategoryName
 */
export function buildCategorySelectEmbed(selectedCategoryId = null, selectedCategoryName = null) {
  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📂 Pilih Kategori")
    .setDescription(
      "Pilih kategori yang akan digunakan sebagai lokasi panel Database.\n\n" +
      "Bot akan membuat channel berikut di dalam kategori yang dipilih:\n" +
      "`⚙️ bot-setting` • `📦 backup` • `📄 console` • `👥 member-list`\n\n" +
      (selectedCategoryId
        ? `✅ **Kategori dipilih:** ${selectedCategoryName ?? "—"} (<#${selectedCategoryId}>)`
        : "⏳ Belum ada kategori yang dipilih."),
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildCategorySelectComponents(selectedCategoryId = null) {
  return [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("db:select:category")
        .setPlaceholder("📂 Pilih kategori...")
        .addChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("db:setup:wizard:create")
        .setLabel("➡️ Lanjut")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!selectedCategoryId),
      new ButtonBuilder()
        .setCustomId("db:setup:cancel")
        .setLabel("❌ Batal")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Setup Berhasil ────────────────────────────────────────────────────────────

/**
 * @param {string} categoryName
 * @param {{ botSetting: string, backup: string, console: string, memberList: string }} channels
 */
export function buildSetupSuccessEmbed(categoryName, channels) {
  return new EmbedBuilder()
    .setColor(COLOR.GREEN)
    .setTitle("✅ Setup Database Berhasil")
    .addFields(
      { name: "📂 Kategori",    value: `**${categoryName}**`,            inline: false },
      { name: "✔ bot-setting",  value: `<#${channels.botSetting}>`,      inline: true  },
      { name: "✔ backup",       value: `<#${channels.backup}>`,           inline: true  },
      { name: "✔ console",      value: `<#${channels.console}>`,          inline: true  },
      { name: "✔ member-list",  value: `<#${channels.memberList}>`,       inline: true  },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/**
 * Tombol setelah setup berhasil — link langsung ke panel yang dibuat.
 * @param {string} guildId
 * @param {{ botSetting: string, backup: string }} channels
 * @param {{ botSetting: string|null, backup: string|null }} messages
 */
export function buildSetupSuccessComponents(guildId, channels, messages) {
  const btns = [];

  if (channels.botSetting && messages.botSetting) {
    btns.push(
      new ButtonBuilder()
        .setLabel("⚙️ Bot Setting")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${guildId}/${channels.botSetting}/${messages.botSetting}`),
    );
  }
  if (channels.backup && messages.backup) {
    btns.push(
      new ButtonBuilder()
        .setLabel("📦 Backup")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${guildId}/${channels.backup}/${messages.backup}`),
    );
  }
  btns.push(
    new ButtonBuilder().setCustomId("db:setup:close").setLabel("❌ Tutup").setStyle(ButtonStyle.Danger),
  );

  return [new ActionRowBuilder().addComponents(...btns)];
}

// ── Manage (sudah pernah setup) ───────────────────────────────────────────────

/** @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup */
export function buildSetupManageEmbed(setup) {
  const ch = setup.channels;

  const setupTime = setup.createdAt
    ? new Date(setup.createdAt).toLocaleString("id-ID")
    : "—";

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📊 Database Manager")
    .addFields(
      { name: "📌 Status",      value: "🟢 Sudah Dikonfigurasi",                                          inline: true  },
      { name: "📂 Kategori",    value: setup.categoryName ?? "DATABASE",                                   inline: true  },
      { name: "🕐 Waktu Setup", value: setupTime,                                                          inline: false },
      { name: "⚙️ Bot Setting", value: ch.botSetting  ? `✔ <#${ch.botSetting}>`  : "❌ Belum dibuat",    inline: true  },
      { name: "📦 Backup",      value: ch.backup       ? `✔ <#${ch.backup}>`       : "❌ Belum dibuat",   inline: true  },
      { name: "📄 Console",     value: ch.console      ? `✔ <#${ch.console}>`      : "❌ Belum dibuat",   inline: true  },
      { name: "👥 Member List", value: ch.memberList   ? `✔ <#${ch.memberList}>`   : "❌ Belum dibuat",   inline: true  },
    )
    .setDescription("Silakan pilih menu.")
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildSetupManageComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:manage:edit").setLabel("📝 Edit Setup").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:manage:repair").setLabel("🔄 Repair Panel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("db:manage:reset").setLabel("🗑 Hapus Setup").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("db:manage:github").setLabel("☁ GitHub Manager").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("db:setup:close").setLabel("❌ Tutup").setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Reset Konfirmasi ──────────────────────────────────────────────────────────

export function buildResetConfirmEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR.RED)
    .setTitle("⚠️ Konfirmasi Hapus Setup")
    .addFields(
      {
        name:  "Yang akan dihapus",
        value:
          "✔ Panel Database\n" +
          "✔ Konfigurasi Setup\n" +
          "✔ ID Channel\n" +
          "✔ Kategori Database (jika kosong)",
        inline: true,
      },
      {
        name:  "Yang TIDAK dihapus",
        value:
          "✔ Database User\n" +
          "✔ Premium\n" +
          "✔ Backup Lokal\n" +
          "✔ Backup GitHub\n" +
          "✔ Scanner\n" +
          "✔ AI\n" +
          "✔ Plugin\n" +
          "✔ Assets\n" +
          "✔ Session\n" +
          "✔ Settings",
        inline: true,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildResetConfirmComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:manage:reset:confirm").setLabel("🗑 Ya, Hapus Setup").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("db:manage:reset:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── GitHub Manager ────────────────────────────────────────────────────────────

/**
 * Resolusi token: env lebih prioritas dari DB.
 * @returns {{ source: "env"|"db"|"none", masked: string }}
 */
function _resolveTokenDisplay(setup) {
  // Prioritas 1: token yang disimpan via panel Discord (Edit Kredensial)
  const dbToken = setup.github?.token;
  if (dbToken) return { source: "db", masked: "✅ GitHub Token\nDikonfigurasi" };
  // Prioritas 2: fallback ke environment variable
  if (process.env.GITHUB_TOKEN) return { source: "env", masked: "✅ GitHub Token\nDikonfigurasi" };
  return { source: "none", masked: "❌ GitHub Token\nBelum dikonfigurasi" };
}

/** @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup */
export function buildGitHubManagerEmbed(setup) {
  const repo   = setup.github?.repo   || null;
  const branch = setup.github?.branch || "main";
  const token  = _resolveTokenDisplay(setup);

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("☁️ GitHub Manager")
    .setDescription("Konfigurasi GitHub untuk upload backup otomatis ke GitHub Releases.")
    .addFields(
      { name: "🐙 Repository",   value: repo ? `\`${repo}\``  : "❌ Belum dikonfigurasi", inline: true  },
      { name: "🌿 Branch",       value: `\`${branch}\``,                                   inline: true  },
      { name: "🔑 Token",        value: token.masked,                                       inline: false },
      { name: "🔄 Auto Backup",  value: setup.autoBackup ? "✅ Aktif" : "❌ Nonaktif",     inline: true  },
      { name: "🧹 Auto Clean",   value: setup.autoClean  ? "✅ Aktif" : "❌ Nonaktif",     inline: true  },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/** @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup */
export function buildGitHubManagerComponents(setup) {
  const backupLabel = setup?.autoBackup ? "🔄 Auto Backup: ✅ ON" : "🔄 Auto Backup: ❌ OFF";
  const cleanLabel  = setup?.autoClean  ? "🧹 Auto Clean: ✅ ON"  : "🧹 Auto Clean: ❌ OFF";
  const backupStyle = setup?.autoBackup ? ButtonStyle.Success : ButtonStyle.Secondary;
  const cleanStyle  = setup?.autoClean  ? ButtonStyle.Success : ButtonStyle.Secondary;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("db:manage:github:edit")
        .setLabel("🔑 Edit Kredensial (Repo / Branch / Token)")
        .setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:manage:github:backup:toggle").setLabel(backupLabel).setStyle(backupStyle),
      new ButtonBuilder().setCustomId("db:manage:github:clean:toggle").setLabel(cleanLabel).setStyle(cleanStyle),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:manage:github:back").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: BOT SETTING
// ════════════════════════════════════════════════════════════════════════════

/** @param {import("discord.js").Client} client */
export function buildBotSettingEmbed(client, setup) {
  const uptimeMs   = client.uptime ?? 0;
  const version    = _readVersion();
  const dbSize     = _readDataDirSize();
  // Prioritas 1: dari panel Discord; Prioritas 2: env var; tidak pernah tampilkan nilai token
  const githubRepo  = setup.github?.repo   || process.env.GITHUB_REPO  || "Belum dikonfigurasi";
  const githubToken = (setup.github?.token || process.env.GITHUB_TOKEN) ? "✅ Dikonfigurasi" : "❌ Belum dikonfigurasi";

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("⚙️ Bot Setting")
    .setDescription("Konfigurasi dan status sistem bot secara real-time.")
    .addFields(
      { name: "🤖 Bot",          value: client.user?.tag ?? "—",                        inline: true  },
      { name: "📦 Versi",        value: `v${version}`,                                   inline: true  },
      { name: "⏱ Uptime",        value: formatUptime(uptimeMs),                          inline: true  },
      { name: "💾 Database",     value: dbSize,                                           inline: true  },
      { name: "📂 Kategori",     value: setup.categoryName ?? "—",                        inline: true  },
      { name: "🐙 GitHub Repo",  value: `\`${githubRepo}\``,                              inline: true  },
      { name: "🔑 GitHub Token", value: githubToken,                                     inline: true  },
      { name: "🔄 Auto Backup",  value: setup.autoBackup ? "✅ Aktif" : "❌ Nonaktif",   inline: true  },
      { name: "🧹 Auto Clean",   value: setup.autoClean  ? "✅ Aktif" : "❌ Nonaktif",   inline: true  },
      {
        name:  "📌 Dibuat",
        value: setup.createdAt ? new Date(setup.createdAt).toLocaleString("id-ID") : "—",
        inline: false,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/** @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup */
export function buildBotSettingComponents(setup) {
  const backupLabel = setup?.autoBackup ? "🔄 Auto Backup: ✅ ON" : "🔄 Auto Backup: ❌ OFF";
  const cleanLabel  = setup?.autoClean  ? "🧹 Auto Clean: ✅ ON"  : "🧹 Auto Clean: ❌ OFF";
  const backupStyle = setup?.autoBackup ? ButtonStyle.Success : ButtonStyle.Secondary;
  const cleanStyle  = setup?.autoClean  ? ButtonStyle.Success : ButtonStyle.Secondary;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:setting:edit").setLabel("🔑 Edit Kredensial").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:panel:setting:refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:setting:backup:toggle").setLabel(backupLabel).setStyle(backupStyle),
      new ButtonBuilder().setCustomId("db:panel:setting:clean:toggle").setLabel(cleanLabel).setStyle(cleanStyle),
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: BACKUP
// ════════════════════════════════════════════════════════════════════════════

/**
 * Panel Backup profesional dengan semua informasi sistem.
 * @param {import("discord.js").Client} client
 * @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup
 * @param {{ getNextBackupAt?: Function, SCHEDULE_LABELS?: Object, formatScheduleTime?: Function }} [sched]
 */
export function buildBackupPanelEmbed(client, setup, sched = {}) {
  const version  = _readVersion();
  const uptime   = client?.uptime ?? 0;
  const dbToken  = setup.github?.token || process.env.GITHUB_TOKEN;
  const dbRepo   = setup.github?.repo  || process.env.GITHUB_REPO;
  const branch   = setup.github?.branch || "main";
  const uploadMode = setup.github?.uploadMode ?? "release";

  // ── Backup info ──────────────────────────────────────────────────────────
  const lastBackupStr = setup.lastBackup
    ? `📁 ${setup.lastBackup.name}\n📏 ${setup.lastBackup.size}\n🕐 ${new Date(setup.lastBackup.at).toLocaleString("id-ID")}`
    : "Belum ada backup";

  const schedLabel  = (sched.SCHEDULE_LABELS && setup.backupSchedule)
    ? sched.SCHEDULE_LABELS[setup.backupSchedule] : null;
  const nextAt      = (sched.getNextBackupAt) ? sched.getNextBackupAt(setup) : null;
  const nextStr     = nextAt && sched.formatScheduleTime ? sched.formatScheduleTime(nextAt) : "—";

  // ── Storage ringkas ──────────────────────────────────────────────────────
  const dataSize = _readDataDirSize();

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📦 Database & Backup Panel")
    .setDescription("Sistem manajemen backup, storage, dan monitoring bot secara real-time.")
    .addFields(
      // ── Bot Info ──────────────────────────────────────────────────────────
      { name: "🤖 Bot",     value: client?.user?.tag ?? "—", inline: true },
      { name: "📦 Versi",   value: `v${version}`,            inline: true },
      { name: "🟢 Status",  value: "Online",                  inline: true },
      { name: "⏱ Uptime",   value: formatUptime(uptime),      inline: true },
      { name: "\u200b",     value: "\u200b",                  inline: true },
      { name: "\u200b",     value: "\u200b",                  inline: true },

      // ── Database ──────────────────────────────────────────────────────────
      { name: "━━━ 🗄 DATABASE ━━━",  value: "\u200b",           inline: false },
      { name: "📂 Database",          value: dataSize,            inline: true  },
      { name: "📂 Kategori",          value: setup.categoryName ?? "—", inline: true },
      { name: "📂 Dibuat",            value: setup.createdAt
          ? new Date(setup.createdAt).toLocaleDateString("id-ID") : "—", inline: true },

      // ── GitHub Backup ─────────────────────────────────────────────────────
      { name: "━━━ ☁ GITHUB BACKUP ━━━", value: "\u200b",         inline: false },
      { name: "🐙 Repository", value: dbRepo ? `\`${dbRepo}\`` : "❌ Belum", inline: true },
      { name: "🌿 Branch",     value: `\`${branch}\``,                       inline: true },
      { name: "🔑 Token",      value: dbToken ? "✅ Dikonfigurasi" : "❌ Belum", inline: true },
      { name: "📤 Mode Upload",value: uploadMode === "branch" ? "Branch Commit" : "GitHub Release", inline: true },
      { name: "\u200b",        value: "\u200b", inline: true },
      { name: "\u200b",        value: "\u200b", inline: true },

      // ── Auto Backup ───────────────────────────────────────────────────────
      { name: "━━━ 🔄 AUTO BACKUP ━━━", value: "\u200b",            inline: false },
      { name: "📋 Status",      value: setup.autoBackup  ? "✅ Aktif" : "❌ Nonaktif",  inline: true },
      { name: "⏰ Jadwal",      value: schedLabel ?? "—",                               inline: true },
      { name: "⏭ Berikutnya",  value: nextStr,                                          inline: true },
      { name: "💾 Terakhir",   value: lastBackupStr,                                    inline: false },
      { name: "🔢 Total Backup",value: String(setup.backupCount ?? 0),                  inline: true },

      // ── Smart Clean ───────────────────────────────────────────────────────
      { name: "━━━ 🧹 SMART CLEAN ━━━", value: "\u200b",           inline: false },
      { name: "📋 Status",      value: setup.autoClean ? "✅ Aktif" : "❌ Nonaktif",    inline: true },
      { name: "🎯 Target",      value: "Cache • Temp • Log >7hr • Backup Lama",        inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildBackupPanelComponents(setup = {}) {
  const autoLabel  = setup.autoBackup ? "🔄 Auto Backup: ✅" : "🔄 Auto Backup: ❌";
  const autoStyle  = setup.autoBackup ? ButtonStyle.Success : ButtonStyle.Secondary;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:backup:backup").setLabel("💾 Backup").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("db:panel:backup:restore").setLabel("♻ Restore").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:panel:backup:storage").setLabel("📊 Storage").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:backup:github").setLabel("🔑 Edit GitHub").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:panel:backup:schedule").setLabel("⚙ Jadwal Backup").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("db:panel:backup:smartclean").setLabel("🧹 Smart Clean").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:setting:backup:toggle").setLabel(autoLabel).setStyle(autoStyle),
      new ButtonBuilder().setCustomId("db:panel:backup:refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: STORAGE
// ════════════════════════════════════════════════════════════════════════════

export function buildStorageEmbed(stats) {
  const s = stats.strings;

  // ── Semua kategori dengan label, emoji, dan apakah bisa dibersihkan ────────
  const ALL_CATS = [
    { key: "database", label: "Database", emoji: "💾",  cleanable: false },
    { key: "source",   label: "Source",   emoji: "📝",  cleanable: false },
    { key: "config",   label: "Config",   emoji: "⚙️",  cleanable: false },
    { key: "assets",   label: "Assets",   emoji: "🖼",  cleanable: false },
    { key: "logs",     label: "Logs",     emoji: "📋",  cleanable: false },
    { key: "backup",   label: "Backup",   emoji: "📦",  cleanable: false },
    { key: "session",  label: "Session",  emoji: "🔒",  cleanable: false },
    { key: "plugins",  label: "Plugins",  emoji: "🔌",  cleanable: false },
    { key: "storage",  label: "Storage",  emoji: "🗂",  cleanable: false },
    { key: "scripts",  label: "Scripts",  emoji: "📜",  cleanable: false },
    { key: "cache",    label: "Cache",    emoji: "🗃",  cleanable: true  },
    { key: "temp",     label: "Temp",     emoji: "📁",  cleanable: true  },
  ];

  // Hanya tampilkan kategori dengan ukuran > 0
  const active = ALL_CATS.filter((c) => (stats[c.key] ?? 0) > 0);

  // Total hanya dari kategori yang ada
  const realTotal = active.reduce((sum, c) => sum + (stats[c.key] ?? 0), 0);

  const embed = new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📊 Storage — Penggunaan Penyimpanan");

  // ── Field per kategori aktif ────────────────────────────────────────────────
  if (active.length === 0) {
    embed.setDescription("Tidak ada data penyimpanan yang terdeteksi.");
  } else {
    for (const cat of active) {
      embed.addFields({ name: `${cat.emoji} ${cat.label}`, value: s[cat.key], inline: true });
    }

    // Padding agar baris terakhir rapi di Discord (3 kolom per baris)
    const rem = active.length % 3;
    if (rem === 1) embed.addFields({ name: "\u200b", value: "\u200b", inline: true }, { name: "\u200b", value: "\u200b", inline: true });
    if (rem === 2) embed.addFields({ name: "\u200b", value: "\u200b", inline: true });

    embed.addFields({ name: "📊 Total", value: `**${formatBytes(realTotal)}**`, inline: false });
  }

  // ── Info disk (jika tersedia) ────────────────────────────────────────────────
  if (stats.diskTotal > 0) {
    embed.addFields(
      { name: "💽 Disk Total", value: s.diskTotal, inline: true },
      { name: "💿 Sisa Disk",  value: s.diskFree,  inline: true },
    );
  }

  // ── Bisa Dibersihkan ────────────────────────────────────────────────────────
  const cleanable = active.filter((c) => c.cleanable);
  if (cleanable.length > 0) {
    embed.addFields({
      name:  "🟢 Bisa Dibersihkan",
      value: cleanable.map((c) => `• ${c.label}`).join("\n"),
      inline: true,
    });
  } else {
    embed.addFields({
      name:  "🟢 Bisa Dibersihkan",
      value: "🧹 Tidak ada file sampah.\nStorage dalam kondisi bersih.",
      inline: false,
    });
  }

  // ── Jangan Dibersihkan ──────────────────────────────────────────────────────
  const protected_ = active.filter((c) => !c.cleanable);
  if (protected_.length > 0) {
    embed.addFields({
      name:  "🔴 Jangan Dibersihkan",
      value: [
        ...protected_.map((c) => `• ${c.label}`),
        "• Environment",
        "• Secrets",
      ].join("\n"),
      inline: true,
    });
  } else {
    embed.addFields({
      name:  "🔴 Jangan Dibersihkan",
      value: "• Environment\n• Secrets",
      inline: true,
    });
  }

  return embed.setFooter({ text: FOOTER }).setTimestamp();
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: SMART CLEAN
// ════════════════════════════════════════════════════════════════════════════

export function buildSmartCleanResultEmbed(result) {
  const safe   = result.safe.length;
  const review = result.review.length;
  const prot   = result.protected.length;

  return new EmbedBuilder()
    .setColor(COLOR.YELLOW)
    .setTitle("🔍 Smart Clean — Hasil Pemindaian")
    .setDescription(
      `Pemindaian selesai pada **${new Date(result.scannedAt).toLocaleString("id-ID")}**\n\n` +
      `Total yang bisa dibersihkan: **${safe} item** (${result.totalSafeSizeStr})`,
    )
    .addFields(
      {
        name: "🟢 Aman Dibersihkan",
        value: safe > 0
          ? `**${safe} item** — ${result.totalSafeSizeStr}\n${result.safe.slice(0, 5).map((f) => `\`${f.rel.slice(0, 50)}\``).join("\n")}${safe > 5 ? `\n... dan ${safe - 5} lainnya` : ""}`
          : "Tidak ada file yang perlu dibersihkan.",
        inline: false,
      },
      {
        name: "🟡 Perlu Ditinjau",
        value: review > 0
          ? `**${review} item**\n${result.review.slice(0, 3).map((f) => `\`${f.rel.slice(0, 50)}\``).join("\n")}${review > 3 ? `\n... dan ${review - 3} lainnya` : ""}`
          : "Tidak ada.",
        inline: false,
      },
      {
        name:  "🔴 File Penting",
        value: `**${prot} item** dilindungi — tidak akan dihapus.`,
        inline: false,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

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

export function buildSmartCleanDetailEmbed(result) {
  const allItems = [...result.safe, ...result.review].slice(0, 20);
  const lines = allItems.map((f) => {
    const cat    = result.safe.includes(f) ? "🟢" : "🟡";
    const label  = f.rel.slice(0, 60);
    const reason = f.reason.slice(0, 100);
    return `${cat} \`${label}\`\n↳ *${reason}*`;
  });

  return new EmbedBuilder()
    .setColor(COLOR.YELLOW)
    .setTitle("📄 Smart Clean — Detail File")
    .setDescription((lines.join("\n\n") || "Tidak ada file.").slice(0, 4000))
    .addFields({
      name:  "📌 Catatan",
      value: "File 🟡 tidak ikut dibersihkan. Hanya file 🟢 yang dihapus.",
      inline: false,
    })
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

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

export function buildCleanConfirmComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:clean:confirmyes").setLabel("✅ Ya, Hapus").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("db:panel:clean:confirmno").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: RESTORE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Embed daftar GitHub Releases yang tersedia untuk dipilih sebagai restore point.
 * @param {Array<{id,name,tag,createdAt,assets}>} releases
 */
export function buildRestoreListEmbed(releases) {
  return new EmbedBuilder()
    .setColor(COLOR.YELLOW)
    .setTitle("♻ Restore — Pilih Backup")
    .setDescription(
      releases.length > 0
        ? `Pilih backup yang ingin di-restore dari dropdown di bawah.\n\n` +
          `⚠️ **Perhatian:** File project akan di-overwrite. Bot akan restart otomatis setelah restore selesai.`
        : "❌ Tidak ada backup tersedia di GitHub Releases.\n\nBuat backup terlebih dahulu menggunakan tombol **💾 Backup**.",
    )
    .addFields(
      releases.slice(0, 5).map((r, i) => ({
        name:   `${i + 1}. ${r.name}`,
        value:  `📅 ${new Date(r.createdAt).toLocaleString("id-ID")}\n📦 ${r.assets.length} file (${r.assets[0]?.sizeStr ?? "—"})`,
        inline: false,
      })),
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/**
 * Komponen dropdown untuk memilih release yang akan di-restore.
 * @param {Array<{id,name,createdAt,assets}>} releases
 */
export function buildRestoreListComponents(releases) {
  if (releases.length === 0) return [];
  const options = releases.slice(0, 25).map(r =>
    new StringSelectMenuOptionBuilder()
      .setValue(r.assets[0]?.downloadUrl ?? r.id)
      .setLabel(r.name.slice(0, 100))
      .setDescription(`${new Date(r.createdAt).toLocaleDateString("id-ID")} • ${r.assets[0]?.sizeStr ?? "—"}`)
      .setEmoji("📦"),
  );
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("db:restore:select")
        .setPlaceholder("Pilih backup untuk di-restore...")
        .addOptions(options),
    ),
  ];
}

/**
 * Embed konfirmasi sebelum eksekusi restore.
 * @param {string} releaseName
 */
export function buildRestoreConfirmEmbed(releaseName) {
  return new EmbedBuilder()
    .setColor(COLOR.RED)
    .setTitle("⚠️ Konfirmasi Restore")
    .setDescription(
      `Kamu akan me-restore backup:\n\n**📦 ${releaseName}**\n\n` +
      "Semua file project saat ini akan **di-overwrite** dengan isi backup ini.\n" +
      "Bot akan **restart otomatis** setelah restore selesai.\n\n" +
      "**Yakin ingin melanjutkan?**",
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/**
 * @param {string} assetDownloadUrl
 */
export function buildRestoreConfirmComponents(assetDownloadUrl) {
  const safeId = Buffer.from(assetDownloadUrl).toString("base64").slice(0, 80);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`db:restore:exec:${safeId}`).setLabel("✅ Ya, Restore Sekarang").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("db:restore:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: JADWAL BACKUP
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup
 * @param {string|null} nextAt  ISO string kapan backup berikutnya
 */
export function buildScheduleEmbed(setup, nextAt) {
  const schedLabels = { "6h": "Setiap 6 Jam", "12h": "Setiap 12 Jam", "daily": "Setiap Hari", "weekly": "Setiap Minggu" };
  const current = setup.backupSchedule ? schedLabels[setup.backupSchedule] : "Tidak Terjadwal";

  const nextStr = nextAt
    ? new Date(nextAt).toLocaleString("id-ID")
    : (setup.backupSchedule ? "Setelah backup pertama" : "—");

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("⚙️ Jadwal Auto Backup")
    .setDescription("Atur kapan bot membuat backup secara otomatis.")
    .addFields(
      { name: "📋 Jadwal Aktif", value: `**${current}**`,                              inline: true },
      { name: "🔄 Auto Backup",  value: setup.autoBackup ? "✅ Aktif" : "❌ Nonaktif", inline: true },
      { name: "⏭ Berikutnya",   value: nextStr,                                        inline: true },
      { name: "💾 Terakhir",    value: setup.lastBackup
          ? `${setup.lastBackup.name}\n${new Date(setup.lastBackup.at).toLocaleString("id-ID")}`
          : "Belum ada backup",                                                          inline: false },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

/**
 * @param {string|null} currentSchedule
 */
export function buildScheduleComponents(currentSchedule) {
  const opts = [
    { id: "6h",     label: "Setiap 6 Jam",   style: ButtonStyle.Primary   },
    { id: "12h",    label: "Setiap 12 Jam",  style: ButtonStyle.Primary   },
    { id: "daily",  label: "Setiap Hari",    style: ButtonStyle.Primary   },
    { id: "weekly", label: "Setiap Minggu",  style: ButtonStyle.Primary   },
  ];
  return [
    new ActionRowBuilder().addComponents(
      ...opts.map(o =>
        new ButtonBuilder()
          .setCustomId(`db:schedule:set:${o.id}`)
          .setLabel(o.label)
          .setStyle(o.id === currentSchedule ? ButtonStyle.Success : o.style),
      ),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:schedule:set:off").setLabel("🚫 Matikan Jadwal").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("db:schedule:back").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function buildBackupActionComponents(tmpId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`db:panel:backup:download:${tmpId}`).setLabel("📥 Download").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`db:panel:backup:upload:${tmpId}`).setLabel("☁ Upload GitHub").setStyle(ButtonStyle.Primary),
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: MEMBER LIST
// ════════════════════════════════════════════════════════════════════════════

export function buildMemberListEmbed(stats) {
  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("👥 Member List")
    .setDescription("Statistik anggota server secara real-time.")
    .addFields(
      { name: "👥 Total Member",   value: `**${stats.total}**`,      inline: true },
      { name: "👑 Premium",        value: `**${stats.premium}**`,     inline: true },
      { name: "🔱 CEO",            value: `**${stats.ceo}**`,         inline: true },
      { name: "🚫 Blacklist",      value: `**${stats.blacklist}**`,   inline: true },
      { name: "✅ Aktif Hari Ini", value: `**${stats.activeToday}**`, inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

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

// ════════════════════════════════════════════════════════════════════════════
// HELPERS INTERNAL
// ════════════════════════════════════════════════════════════════════════════

function _readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")).version ?? "2.0.0";
  } catch { return "2.0.0"; }
}

function _readDataDirSize() {
  try {
    const dir = path.join(ROOT_DIR, "data");
    if (!fs.existsSync(dir)) return "0 KB";
    let total = 0;
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch { /* skip */ }
    }
    if (total < 1024)        return `${total} B`;
    if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`;
    return `${(total / (1024 * 1024)).toFixed(2)} MB`;
  } catch { return "N/A"; }
}
