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

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📊 Database")
    .addFields(
      { name: "📌 Status",      value: "🟢 Aktif",                                                      inline: true  },
      { name: "📂 Kategori",    value: setup.categoryName ?? "—",                                         inline: true  },
      { name: "⚙️ Bot Setting", value: ch.botSetting  ? `<#${ch.botSetting}>`  : "❌ Belum dibuat",      inline: true  },
      { name: "📦 Backup",      value: ch.backup       ? `<#${ch.backup}>`       : "❌ Belum dibuat",     inline: true  },
      { name: "📄 Console",     value: ch.console      ? `<#${ch.console}>`      : "❌ Belum dibuat",     inline: true  },
      { name: "👥 Member List", value: ch.memberList   ? `<#${ch.memberList}>`   : "❌ Belum dibuat",     inline: true  },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildSetupManageComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:manage:edit").setLabel("📝 Edit Setup").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:manage:repair").setLabel("🔄 Repair Panel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("db:manage:reset").setLabel("🗑 Reset Setup").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("db:manage:github").setLabel("☁️ GitHub Manager").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("db:setup:close").setLabel("❌ Tutup").setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Reset Konfirmasi ──────────────────────────────────────────────────────────

export function buildResetConfirmEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR.RED)
    .setTitle("⚠️ Reset Setup")
    .addFields(
      {
        name:  "Yang akan dihapus",
        value: "✔ Konfigurasi Setup\n✔ Channel ID\n✔ Panel Database",
        inline: true,
      },
      {
        name:  "Yang TIDAK dihapus",
        value: "✔ Database User\n✔ Premium\n✔ Backup Lokal\n✔ Backup GitHub\n✔ Data Scanner\n✔ AI",
        inline: true,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildResetConfirmComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:manage:reset:confirm").setLabel("🗑 Ya, Reset").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("db:manage:reset:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── GitHub Manager ────────────────────────────────────────────────────────────

/** @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup */
export function buildGitHubManagerEmbed(setup) {
  const repo  = process.env.GITHUB_REPO || setup.github?.repo || null;
  const token = process.env.GITHUB_TOKEN ? "✅ Dikonfigurasi" : "❌ Belum ada";

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("☁️ GitHub Manager")
    .setDescription(
      "Konfigurasi GitHub untuk upload backup otomatis ke GitHub Releases.",
    )
    .addFields(
      { name: "🐙 GitHub Repo",  value: repo ? `\`${repo}\`` : "❌ Belum dikonfigurasi", inline: true },
      { name: "🔑 GitHub Token", value: token,                                            inline: true },
      {
        name: "📌 Cara Mengatur",
        value:
          "1. Tambahkan **GITHUB_TOKEN** di Replit Secrets\n" +
          "2. Klik **✏️ Ubah Konfigurasi** dan masukkan `owner/repo`",
        inline: false,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildGitHubManagerComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:manage:github:edit").setLabel("✏️ Ubah Konfigurasi").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:setup:close").setLabel("❌ Tutup").setStyle(ButtonStyle.Danger),
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
  const githubRepo = process.env.GITHUB_REPO || setup.github?.repo || "Belum dikonfigurasi";
  const githubToken = process.env.GITHUB_TOKEN ? "✅ Dikonfigurasi" : "❌ Belum ada";

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

export function buildBotSettingComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:panel:setting:edit").setLabel("⚙️ Edit").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("db:panel:setting:refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: BACKUP
// ════════════════════════════════════════════════════════════════════════════

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
    .addFields({ name: "💾 Backup Terakhir", value: lastInfo, inline: false })
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

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

// ════════════════════════════════════════════════════════════════════════════
// PANEL: STORAGE
// ════════════════════════════════════════════════════════════════════════════

export function buildStorageEmbed(stats) {
  const s = stats.strings;
  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("📊 Storage — Penggunaan Penyimpanan")
    .addFields(
      { name: "💾 Database",   value: s.database,         inline: true },
      { name: "🗃 Cache",      value: s.cache,             inline: true },
      { name: "📁 Temp",       value: s.temp,              inline: true },
      { name: "📦 Backup",     value: s.backup,            inline: true },
      { name: "🖼 Assets",     value: s.assets,            inline: true },
      { name: "📋 Logs",       value: s.logs,              inline: true },
      { name: "📝 Source",     value: s.source,            inline: true },
      { name: "📊 Total",      value: `**${s.total}**`,    inline: true },
      { name: "💽 Disk Total", value: s.diskTotal,         inline: true },
      { name: "💿 Sisa Disk",  value: s.diskFree,          inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
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
