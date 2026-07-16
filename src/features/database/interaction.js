/**
 * features/database/interaction.js — Handler semua interaksi dengan prefix "db:".
 *
 * Custom ID yang ditangani:
 *
 *  Setup wizard:
 *   db:setup:open            — Buka setup (wizard jika baru, manage jika sudah)
 *   db:setup:wizard:existing — Tampilkan CategorySelectMenu
 *   db:setup:wizard:new      — Tampilkan modal nama kategori baru
 *   db:setup:wizard:create   — Buat channel di kategori yang dipilih
 *   db:setup:cancel          — Tutup/batal
 *   db:setup:close           — Tutup
 *   db:select:category       — ChannelSelectMenu pilih kategori
 *   db:modal:category        — Submit nama kategori baru → buat kategori + channel
 *
 *  Manage (sudah setup):
 *   db:manage:edit           — Edit setup (jalankan ulang wizard)
 *   db:manage:repair         — Repair panel yang hilang
 *   db:manage:reset          — Tampilkan konfirmasi reset
 *   db:manage:reset:confirm  — Eksekusi reset
 *   db:manage:reset:cancel   — Batal reset
 *   db:manage:github         — Tampilkan GitHub Manager
 *   db:manage:github:edit    — Modal ubah GitHub repo
 *   db:modal:github          — Submit simpan GitHub config
 *
 *  Panel Bot Setting:
 *   db:panel:setting:edit    — Modal edit pengaturan
 *   db:panel:setting:refresh — Refresh panel
 *   db:modal:setting         — Submit simpan pengaturan
 *
 *  Panel Backup:
 *   db:panel:backup:backup         — Buat ZIP backup
 *   db:panel:backup:smartclean     — Jalankan Smart Clean
 *   db:panel:backup:storage        — Info storage
 *   db:panel:backup:refresh        — Refresh panel
 *   db:panel:backup:download:<id>  — Download ZIP
 *   db:panel:backup:upload:<id>    — Upload ke GitHub
 *
 *  Smart Clean:
 *   db:panel:clean:detail     — Detail hasil scan
 *   db:panel:clean:clean      — Tampilkan konfirmasi
 *   db:panel:clean:confirmyes — Eksekusi bersihkan
 *   db:panel:clean:confirmno  — Batal
 *   db:panel:clean:rescan     — Scan ulang
 *
 *  Member List:
 *   db:panel:member:view     — Lihat daftar premium
 *   db:panel:member:search   — Modal cari member
 *   db:panel:member:export   — Export file .txt
 *   db:panel:member:refresh  — Refresh panel
 *   db:modal:member:search   — Submit pencarian member
 */

import {
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  ChannelType,
} from "discord.js";

import { databaseDB }      from "../../database/databaseDB.js";
import { db, premDB }      from "../../database/db.js";
import { isStaff }         from "../../middleware/permissions.js";
import { logger }          from "../../utils/logger.js";
import { logError }        from "../../utils/errorLogger.js";
import { consoleLog }      from "./console.js";
import {
  createBackupZip,
  getBackupEntry,
  uploadBackupToGitHub,
  getStorageStats,
  runSmartClean,
  executeClean,
} from "./backup.js";
import {
  getMemberStats,
  exportMemberList,
  searchMembers,
} from "./memberList.js";
import {
  buildSetupWizardEmbed, buildSetupWizardComponents,
  buildCategorySelectEmbed, buildCategorySelectComponents,
  buildSetupSuccessEmbed, buildSetupSuccessComponents,
  buildSetupManageEmbed, buildSetupManageComponents,
  buildResetConfirmEmbed, buildResetConfirmComponents,
  buildGitHubManagerEmbed, buildGitHubManagerComponents,
  buildBotSettingEmbed, buildBotSettingComponents,
  buildBackupPanelEmbed, buildBackupPanelComponents,
  buildStorageEmbed,
  buildSmartCleanResultEmbed, buildSmartCleanResultComponents,
  buildSmartCleanDetailEmbed, buildSmartCleanDetailComponents,
  buildCleanConfirmComponents,
  buildBackupActionComponents,
  buildMemberListEmbed, buildMemberListComponents,
} from "./embed.js";

// ── In-memory session stores ──────────────────────────────────────────────────

/**
 * Sesi wizard setup.
 * Key: userId
 * Value: { categoryId: string|null, categoryName: string|null }
 */
const _setupSessions = new Map();

/**
 * Sesi Smart Clean (hasil scan sementara).
 * Key: userId, Value: result dari runSmartClean()
 */
const _cleanSessions = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Cek izin staff. Jika bukan staff, reply error dan return true. */
async function _denyNotStaff(interaction) {
  if (isStaff(interaction.member)) return false;
  const replyFn = interaction.deferred || interaction.replied ? "editReply" : "reply";
  await interaction[replyFn]({
    content:  "❌ Kamu tidak memiliki izin untuk menggunakan fitur ini.",
    ephemeral: true,
  }).catch(() => {});
  return true;
}

/** Buat/ambil sesi wizard untuk user. */
function _session(userId) {
  if (!_setupSessions.has(userId)) {
    _setupSessions.set(userId, { categoryId: null, categoryName: null });
  }
  return _setupSessions.get(userId);
}

/**
 * Buat 4 channel DATABASE di dalam kategori yang dipilih.
 * Jika channel dengan nama tersebut sudah ada di kategori, gunakan yang ada.
 * @returns {{ botSetting, backup, console, memberList }} — channel IDs
 */
async function _createChannels(guild, categoryId) {
  const defs = [
    { key: "botSetting", name: "bot-setting" },
    { key: "backup",     name: "backup"      },
    { key: "console",    name: "console"     },
    { key: "memberList", name: "member-list" },
  ];

  const ids = {};
  for (const def of defs) {
    const existing = guild.channels.cache.find(
      (ch) => ch.parentId === categoryId && ch.name === def.name && ch.isTextBased(),
    );
    if (existing) {
      ids[def.key] = existing.id;
    } else {
      const ch = await guild.channels.create({
        name:   def.name,
        type:   ChannelType.GuildText,
        parent: categoryId,
      });
      ids[def.key] = ch.id;
    }
  }
  return ids;
}

/**
 * Hapus pesan panel lama (jika ada) berdasarkan data dari DB saat ini.
 * Tidak throw jika message/channel sudah tidak ada.
 */
async function _deleteOldPanels(client) {
  const setup = databaseDB.get();
  for (const key of ["botSetting", "backup", "memberList"]) {
    const msgId = setup.messages[key];
    const chId  = setup.channels[key];
    if (!msgId || !chId) continue;
    try {
      const ch  = await client.channels.fetch(chId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(msgId).catch(() => null) : null;
      if (msg) await msg.delete();
    } catch { /* ignore */ }
  }
  databaseDB.clearMessages();
}

/**
 * Kirim semua panel ke channel yang sudah dikonfigurasi.
 * Bot Setting, Backup, Member List — Console tidak punya panel statis.
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").Guild} guild
 * @param {ReturnType<import("../../database/databaseDB.js").DatabaseDB["get"]>} setup
 * @returns {string[]} Array pesan error (kosong jika semua sukses)
 */
async function _sendPanels(client, guild, setup) {
  const errors = [];

  // Bot Setting
  try {
    const ch  = await client.channels.fetch(setup.channels.botSetting).catch(() => null);
    if (ch?.isTextBased()) {
      const msg = await ch.send({ embeds: [buildBotSettingEmbed(client, setup)], components: buildBotSettingComponents() });
      databaseDB.setMessage("botSetting", msg.id);
    } else errors.push("⚙️ Bot Setting: channel tidak valid");
  } catch (e) { errors.push(`⚙️ Bot Setting: ${e.message.slice(0, 80)}`); }

  // Backup
  try {
    const ch  = await client.channels.fetch(setup.channels.backup).catch(() => null);
    if (ch?.isTextBased()) {
      const msg = await ch.send({ embeds: [buildBackupPanelEmbed()], components: buildBackupPanelComponents() });
      databaseDB.setMessage("backup", msg.id);
    } else errors.push("📦 Backup: channel tidak valid");
  } catch (e) { errors.push(`📦 Backup: ${e.message.slice(0, 80)}`); }

  // Member List
  try {
    const stats = await getMemberStats(guild, premDB);
    const ch    = await client.channels.fetch(setup.channels.memberList).catch(() => null);
    if (ch?.isTextBased()) {
      const msg = await ch.send({ embeds: [buildMemberListEmbed(stats)], components: buildMemberListComponents() });
      databaseDB.setMessage("memberList", msg.id);
    } else errors.push("👥 Member List: channel tidak valid");
  } catch (e) { errors.push(`👥 Member List: ${e.message.slice(0, 80)}`); }

  return errors;
}

/**
 * Logic inti untuk menyelesaikan setup setelah categoryId dan categoryName tersedia.
 * Dipakai oleh handleSetupWizardCreate dan handleCategoryModalSubmit.
 */
async function _finishSetup(interaction, categoryId, categoryName) {
  // Hapus panel lama jika ini adalah edit
  await _deleteOldPanels(interaction.client);

  // Buat 4 channel
  const guild    = interaction.guild;
  const channels = await _createChannels(guild, categoryId);

  // Simpan ke database
  databaseDB.saveSetup(channels, categoryId, categoryName, guild.id, interaction.user.id);

  const setup = databaseDB.get();

  // Kirim panel ke channel
  const errors = await _sendPanels(interaction.client, guild, setup);

  // Bersihkan sesi
  _setupSessions.delete(interaction.user.id);

  // Log ke console
  consoleLog("db_setup", "🟢 Setup Database", `Setup selesai oleh ${interaction.user.username} di kategori "${categoryName}"`).catch(() => {});

  // Tampilkan embed sukses
  const freshSetup = databaseDB.get();
  const successEmbed = buildSetupSuccessEmbed(categoryName, channels);

  if (errors.length > 0) {
    successEmbed.addFields({ name: "⚠️ Peringatan", value: errors.join("\n"), inline: false });
  }

  await interaction.editReply({
    embeds:     [successEmbed],
    components: buildSetupSuccessComponents(guild.id, freshSetup.channels, freshSetup.messages),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SETUP WIZARD HANDLERS
// ════════════════════════════════════════════════════════════════════════════

async function handleSetupOpen(interaction) {
  if (await _denyNotStaff(interaction)) return;

  if (databaseDB.isSetup()) {
    // Sudah setup — tampilkan manage menu
    await interaction.update({
      embeds:     [buildSetupManageEmbed(databaseDB.get())],
      components: buildSetupManageComponents(),
    });
  } else {
    // Belum setup — tampilkan wizard
    _setupSessions.delete(interaction.user.id); // reset sesi lama
    await interaction.update({
      embeds:     [buildSetupWizardEmbed()],
      components: buildSetupWizardComponents(),
    });
  }
}

async function handleSetupWizardExisting(interaction) {
  if (await _denyNotStaff(interaction)) return;
  const sel = _session(interaction.user.id);
  await interaction.update({
    embeds:     [buildCategorySelectEmbed(sel.categoryId, sel.categoryName)],
    components: buildCategorySelectComponents(sel.categoryId),
  });
}

async function handleSetupWizardNew(interaction) {
  if (await _denyNotStaff(interaction)) return;

  const modal = new ModalBuilder()
    .setCustomId("db:modal:category")
    .setTitle("📂 Buat Kategori Baru")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("category_name")
          .setLabel("Nama Kategori")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(2)
          .setMaxLength(50)
          .setPlaceholder("Contoh: DATABASE"),
      ),
    );

  await interaction.showModal(modal);
}

async function handleCategorySelect(interaction) {
  if (await _denyNotStaff(interaction)) return;

  const categoryId = interaction.values[0];
  const channel    = interaction.guild.channels.cache.get(categoryId);
  const catName    = channel?.name ?? "Kategori";

  const sel = _session(interaction.user.id);
  sel.categoryId   = categoryId;
  sel.categoryName = catName;

  await interaction.update({
    embeds:     [buildCategorySelectEmbed(categoryId, catName)],
    components: buildCategorySelectComponents(categoryId),
  });
}

async function handleSetupWizardCreate(interaction) {
  if (await _denyNotStaff(interaction)) return;

  const sel = _session(interaction.user.id);
  if (!sel.categoryId) {
    await interaction.reply({ content: "❌ Belum ada kategori yang dipilih.", ephemeral: true }).catch(() => {});
    return;
  }

  await interaction.deferUpdate();
  await _finishSetup(interaction, sel.categoryId, sel.categoryName ?? "Kategori");
}

async function handleCategoryModalSubmit(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferUpdate();

  const rawName = interaction.fields.getTextInputValue("category_name").trim();

  try {
    // Buat kategori baru
    const category = await interaction.guild.channels.create({
      name: rawName,
      type: ChannelType.GuildCategory,
    });

    await _finishSetup(interaction, category.id, category.name);
  } catch (err) {
    logger.error(`[Database] Gagal buat kategori: ${err.message}`);
    await interaction.editReply({
      content:    `❌ Gagal membuat kategori: ${err.message.slice(0, 200)}`,
      embeds:     [],
      components: [],
    }).catch(() => {});
  }
}

async function handleSetupClose(interaction) {
  await interaction.update({ content: "✅ Menu ditutup.", embeds: [], components: [] }).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════
// MANAGE HANDLERS
// ════════════════════════════════════════════════════════════════════════════

async function handleManageEdit(interaction) {
  if (await _denyNotStaff(interaction)) return;
  _setupSessions.delete(interaction.user.id);
  await interaction.update({
    embeds:     [buildSetupWizardEmbed()],
    components: buildSetupWizardComponents(),
  });
}

async function handleManageRepair(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferUpdate();

  const setup  = databaseDB.get();
  const client = interaction.client;
  const guild  = interaction.guild;
  const report = [];

  const PANEL_DEFS = [
    { key: "botSetting", label: "⚙️ Bot Setting" },
    { key: "backup",     label: "📦 Backup"      },
    { key: "memberList", label: "👥 Member List"  },
  ];

  for (const def of PANEL_DEFS) {
    const chId  = setup.channels[def.key];
    const msgId = setup.messages[def.key];

    if (!chId) {
      // Channel belum dikonfigurasi — buat di kategori yang sama
      if (!setup.categoryId) { report.push(`${def.label}: ❌ Kategori tidak dikonfigurasi`); continue; }
      try {
        const nameMap = { botSetting: "bot-setting", backup: "backup", memberList: "member-list" };
        const ch = await guild.channels.create({
          name:   nameMap[def.key],
          type:   ChannelType.GuildText,
          parent: setup.categoryId,
        });
        // Simpan channel baru ke DB
        databaseDB._data.channels[def.key] = ch.id;
        databaseDB._save();
        report.push(`${def.label}: ✅ Channel baru dibuat <#${ch.id}>`);
      } catch (e) {
        report.push(`${def.label}: ❌ Gagal buat channel — ${e.message.slice(0, 60)}`);
        continue;
      }
    }

    // Cek apakah pesan panel masih ada
    const freshSetup = databaseDB.get();
    const freshChId  = freshSetup.channels[def.key];
    const freshMsgId = freshSetup.messages[def.key];

    const ch  = freshChId  ? await client.channels.fetch(freshChId).catch(() => null) : null;
    const msg = (ch && freshMsgId) ? await ch.messages.fetch(freshMsgId).catch(() => null) : null;

    if (!msg) {
      // Panel hilang — kirim ulang
      try {
        let newMsg;
        if (def.key === "botSetting") {
          newMsg = await ch.send({ embeds: [buildBotSettingEmbed(client, freshSetup)], components: buildBotSettingComponents() });
        } else if (def.key === "backup") {
          newMsg = await ch.send({ embeds: [buildBackupPanelEmbed()], components: buildBackupPanelComponents() });
        } else {
          const stats = await getMemberStats(guild, premDB);
          newMsg = await ch.send({ embeds: [buildMemberListEmbed(stats)], components: buildMemberListComponents() });
        }
        databaseDB.setMessage(def.key, newMsg.id);
        report.push(`${def.label}: ✅ Panel dikirim ulang`);
      } catch (e) {
        report.push(`${def.label}: ❌ Gagal kirim panel — ${e.message.slice(0, 60)}`);
      }
    } else {
      report.push(`${def.label}: ✅ Normal`);
    }
  }

  consoleLog("db_repair", "🔄 Repair Panel", report.join(" | ")).catch(() => {});

  const freshSetup = databaseDB.get();
  await interaction.editReply({
    embeds: [
      buildSetupManageEmbed(freshSetup).setDescription(`**Hasil Repair:**\n${report.join("\n")}`),
    ],
    components: buildSetupManageComponents(),
  });
}

async function handleManageReset(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.update({
    embeds:     [buildResetConfirmEmbed()],
    components: buildResetConfirmComponents(),
  });
}

async function handleManageResetConfirm(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferUpdate();

  // Hapus panel Discord (bukan channel)
  await _deleteOldPanels(interaction.client);

  // Reset konfigurasi
  databaseDB.reset();

  consoleLog("db_reset", "🗑 Reset Setup", `Dilakukan oleh ${interaction.user.username}`).catch(() => {});

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("🗑 Setup Direset")
        .setDescription(
          "✅ Konfigurasi setup Database berhasil dihapus.\n\n" +
          "📌 Status: 🔴 Belum Setup\n\n" +
          "Jalankan `/setup` kembali untuk mengatur ulang.",
        )
        .setFooter({ text: "Pangeran Assistant AI • Database" })
        .setTimestamp(),
    ],
    components: [],
  });
}

async function handleManageResetCancel(interaction) {
  await interaction.update({
    embeds:     [buildSetupManageEmbed(databaseDB.get())],
    components: buildSetupManageComponents(),
  });
}

async function handleManageGitHub(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.update({
    embeds:     [buildGitHubManagerEmbed(databaseDB.get())],
    components: buildGitHubManagerComponents(),
  });
}

async function handleManageGitHubEdit(interaction) {
  if (await _denyNotStaff(interaction)) return;

  const setup   = databaseDB.get();
  const curRepo = process.env.GITHUB_REPO || setup.github?.repo || "";

  const modal = new ModalBuilder()
    .setCustomId("db:modal:github")
    .setTitle("☁️ Konfigurasi GitHub")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("github_repo")
          .setLabel("GitHub Repo (owner/repo)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100)
          .setPlaceholder("contoh: namaowner/namarepository")
          .setValue(curRepo),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("auto_backup")
          .setLabel("Auto Backup? (ya / tidak)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setValue(setup.autoBackup ? "ya" : "tidak"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("auto_clean")
          .setLabel("Auto Clean? (ya / tidak)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setValue(setup.autoClean ? "ya" : "tidak"),
      ),
    );

  await interaction.showModal(modal);
}

async function handleGitHubModalSubmit(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferUpdate();

  const repo       = interaction.fields.getTextInputValue("github_repo").trim() || null;
  const autoBackup = /^ya$/i.test(interaction.fields.getTextInputValue("auto_backup").trim());
  const autoClean  = /^ya$/i.test(interaction.fields.getTextInputValue("auto_clean").trim());

  databaseDB.updateSettings({ repo, autoBackup, autoClean });

  consoleLog("db_github", "☁️ GitHub Connected", `Repo: ${repo ?? "—"}`).catch(() => {});

  // Refresh panel Bot Setting dengan setting terbaru
  await _refreshBotSettingPanel(interaction.client, databaseDB.get());

  await interaction.editReply({
    embeds:     [buildGitHubManagerEmbed(databaseDB.get())],
    components: buildGitHubManagerComponents(),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: BOT SETTING
// ════════════════════════════════════════════════════════════════════════════

async function handleSettingEdit(interaction) {
  if (await _denyNotStaff(interaction)) return;

  const setup   = databaseDB.get();
  const curRepo = process.env.GITHUB_REPO || setup.github?.repo || "";

  const modal = new ModalBuilder()
    .setCustomId("db:modal:setting")
    .setTitle("⚙️ Edit Bot Setting")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("github_repo")
          .setLabel("GitHub Repo (owner/repo)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100)
          .setPlaceholder("contoh: namaowner/namarepository")
          .setValue(curRepo),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("auto_backup")
          .setLabel("Auto Backup? (ya / tidak)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setValue(setup.autoBackup ? "ya" : "tidak"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("auto_clean")
          .setLabel("Auto Clean? (ya / tidak)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setValue(setup.autoClean ? "ya" : "tidak"),
      ),
    );

  await interaction.showModal(modal);
}

async function handleSettingModalSubmit(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const repo       = interaction.fields.getTextInputValue("github_repo").trim() || null;
  const autoBackup = /^ya$/i.test(interaction.fields.getTextInputValue("auto_backup").trim());
  const autoClean  = /^ya$/i.test(interaction.fields.getTextInputValue("auto_clean").trim());

  databaseDB.updateSettings({ repo, autoBackup, autoClean });
  await _refreshBotSettingPanel(interaction.client, databaseDB.get());
  consoleLog("db_save", "📝 Edit Setup", `Setting diperbarui oleh ${interaction.user.username}`).catch(() => {});
  await interaction.editReply({ content: "✅ Pengaturan disimpan dan panel diperbarui." });
}

async function handleSettingRefresh(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });
  await _refreshBotSettingPanel(interaction.client, databaseDB.get());
  await interaction.editReply({ content: "🔄 Panel Bot Setting diperbarui." });
}

async function _refreshBotSettingPanel(client, setup) {
  if (!setup.channels.botSetting || !setup.messages.botSetting) return;
  try {
    const ch  = await client.channels.fetch(setup.channels.botSetting).catch(() => null);
    const msg = ch ? await ch.messages.fetch(setup.messages.botSetting).catch(() => null) : null;
    if (msg) await msg.edit({ embeds: [buildBotSettingEmbed(client, setup)], components: buildBotSettingComponents() });
  } catch (e) {
    logger.warn(`[Database] Gagal refresh Bot Setting: ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: BACKUP
// ════════════════════════════════════════════════════════════════════════════

async function handleBackupCreate(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await createBackupZip();
    consoleLog("backup", "💾 Backup", `${result.fileName} (${result.sizeStr})`).catch(() => {});

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("💾 Backup Selesai")
          .setDescription(`File backup berhasil dibuat.\n\n📁 **${result.fileName}**\n📏 ${result.sizeStr}`)
          .addFields({ name: "📌 Catatan", value: "File tersedia selama 30 menit.", inline: false })
          .setFooter({ text: "Pangeran Assistant AI • Backup" })
          .setTimestamp(),
      ],
      components: buildBackupActionComponents(result.tmpId),
    });

    await _refreshBackupPanel(interaction.client, { lastAt: result.createdAt, lastName: result.fileName, lastSize: result.sizeStr });
  } catch (err) {
    logger.error(`[Database] Backup gagal: ${err.message}`);
    consoleLog("error", "❌ Error", `Backup gagal: ${err.message}`).catch(() => {});
    await interaction.editReply({ content: `❌ Backup gagal: ${err.message.slice(0, 200)}` });
  }
}

async function handleBackupDownload(interaction, tmpId) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const entry = getBackupEntry(tmpId);
  if (!entry) {
    await interaction.editReply({ content: "❌ File tidak ditemukan atau sudah kedaluwarsa (30 menit)." });
    return;
  }
  try {
    const att = new AttachmentBuilder(entry.filePath, { name: entry.fileName });
    await interaction.editReply({ content: `📥 **${entry.fileName}** (${entry.sizeStr})`, files: [att] });
  } catch (err) {
    await interaction.editReply({ content: `❌ Gagal mengirim file: ${err.message.slice(0, 200)}` });
  }
}

async function handleBackupUpload(interaction, tmpId) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await uploadBackupToGitHub(tmpId);
    consoleLog("backup_upload", "☁️ Upload GitHub", result.url).catch(() => {});
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("☁ Upload GitHub Berhasil")
          .setDescription(`Backup berhasil diupload ke GitHub Release.\n\n🔗 [Lihat Release](${result.url})`)
          .setFooter({ text: "Pangeran Assistant AI • Backup" })
          .setTimestamp(),
      ],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ Upload gagal: ${err.message.slice(0, 300)}` });
  }
}

async function handleStorageInfo(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply({ embeds: [buildStorageEmbed(getStorageStats())] });
}

async function handleBackupRefresh(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });
  await _refreshBackupPanel(interaction.client);
  await interaction.editReply({ content: "🔄 Panel Backup diperbarui." });
}

async function _refreshBackupPanel(client, lastBackup = null) {
  const setup = databaseDB.get();
  if (!setup.channels.backup || !setup.messages.backup) return;
  try {
    const ch  = await client.channels.fetch(setup.channels.backup).catch(() => null);
    const msg = ch ? await ch.messages.fetch(setup.messages.backup).catch(() => null) : null;
    if (msg) await msg.edit({ embeds: [buildBackupPanelEmbed(lastBackup)], components: buildBackupPanelComponents() });
  } catch (e) {
    logger.warn(`[Database] Gagal refresh Backup: ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: SMART CLEAN
// ════════════════════════════════════════════════════════════════════════════

async function handleSmartCleanScan(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const result = runSmartClean();
    _cleanSessions.set(interaction.user.id, result);
    consoleLog("smartclean", "🔍 Smart Clean", `${result.safe.length} aman, ${result.review.length} ditinjau`).catch(() => {});
    await interaction.editReply({
      embeds:     [buildSmartCleanResultEmbed(result)],
      components: buildSmartCleanResultComponents(result.safe.length),
    });
  } catch (err) {
    logger.error(`[Database] Smart Clean gagal: ${err.message}`);
    await interaction.editReply({ content: `❌ Smart Clean gagal: ${err.message.slice(0, 200)}` });
  }
}

async function handleCleanDetail(interaction) {
  if (await _denyNotStaff(interaction)) return;
  const result = _cleanSessions.get(interaction.user.id);
  if (!result) {
    await interaction.reply({ content: "❌ Sesi Smart Clean tidak ditemukan. Jalankan Smart Clean terlebih dahulu.", ephemeral: true });
    return;
  }
  await interaction.update({
    embeds:     [buildSmartCleanDetailEmbed(result)],
    components: buildSmartCleanDetailComponents(result.safe.length),
  });
}

async function handleCleanClean(interaction) {
  if (await _denyNotStaff(interaction)) return;
  const result = _cleanSessions.get(interaction.user.id);
  if (!result || result.safe.length === 0) {
    await interaction.reply({ content: "❌ Tidak ada file yang bisa dibersihkan.", ephemeral: true });
    return;
  }
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle("🧹 Konfirmasi Bersihkan")
        .setDescription(
          `Yakin ingin menghapus **${result.safe.length} item** (${result.totalSafeSizeStr})?\n\n` +
          "Hanya file 🟢 Aman yang dihapus. File penting tidak tersentuh.",
        )
        .setFooter({ text: "Pangeran Assistant AI • Smart Clean" })
        .setTimestamp(),
    ],
    components: buildCleanConfirmComponents(),
  });
}

async function handleCleanConfirmYes(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferUpdate();

  const result = _cleanSessions.get(interaction.user.id);
  if (!result) {
    await interaction.editReply({ content: "❌ Sesi tidak ditemukan.", embeds: [], components: [] });
    return;
  }

  const cleanResult = executeClean(result.safe);
  _cleanSessions.delete(interaction.user.id);
  consoleLog("cleaned", "🧹 Smart Clean", `${cleanResult.deleted} item dihapus, ${cleanResult.freedStr} dibebaskan`).catch(() => {});

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("🧹 Bersihkan Selesai")
        .setDescription(`✅ **${cleanResult.deleted} item** dihapus.\n💾 Dibebaskan: **${cleanResult.freedStr}**`)
        .addFields(
          cleanResult.errors.length > 0
            ? [{ name: "⚠️ Error", value: cleanResult.errors.slice(0, 5).join("\n"), inline: false }]
            : [],
        )
        .setFooter({ text: "Pangeran Assistant AI • Smart Clean" })
        .setTimestamp(),
    ],
    components: [],
  });
}

async function handleCleanConfirmNo(interaction) {
  const result = _cleanSessions.get(interaction.user.id);
  if (result) {
    await interaction.update({
      embeds:     [buildSmartCleanResultEmbed(result)],
      components: buildSmartCleanResultComponents(result.safe.length),
    });
  } else {
    await interaction.update({ content: "❌ Batal.", embeds: [], components: [] });
  }
}

async function handleCleanRescan(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferUpdate();

  const result = runSmartClean();
  _cleanSessions.set(interaction.user.id, result);
  consoleLog("smartclean", "🔍 Smart Clean", `Scan ulang: ${result.safe.length} aman`).catch(() => {});

  await interaction.editReply({
    embeds:     [buildSmartCleanResultEmbed(result)],
    components: buildSmartCleanResultComponents(result.safe.length),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL: MEMBER LIST
// ════════════════════════════════════════════════════════════════════════════

async function handleMemberView(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const stats    = await getMemberStats(interaction.guild, premDB);
    const now      = new Date();
    const premUsers = premDB.getAllPremiumUsers().filter((u) => !u.expiresAt || new Date(u.expiresAt) > now);
    const lines    = premUsers.slice(0, 20).map((u) => {
      const exp = u.expiresAt ? `exp: ${new Date(u.expiresAt).toLocaleDateString("id-ID")}` : "permanent";
      return `• <@${u.userId}> (${exp})`;
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("👥 Daftar Member Premium")
          .setDescription(
            lines.length > 0
              ? lines.join("\n") + (premUsers.length > 20 ? `\n... dan ${premUsers.length - 20} lainnya` : "")
              : "Belum ada member premium.",
          )
          .addFields(
            { name: "👑 Premium",       value: `${stats.premium}`, inline: true },
            { name: "🔱 CEO",           value: `${stats.ceo}`,     inline: true },
            { name: "👥 Total Member",  value: `${stats.total}`,   inline: true },
          )
          .setFooter({ text: "Pangeran Assistant AI • Member List" })
          .setTimestamp(),
      ],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ Gagal memuat daftar: ${err.message.slice(0, 200)}` });
  }
}

async function handleMemberSearch(interaction) {
  if (await _denyNotStaff(interaction)) return;

  const modal = new ModalBuilder()
    .setCustomId("db:modal:member:search")
    .setTitle("🔍 Cari Member")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("query")
          .setLabel("Nama / Username Member")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(2)
          .setMaxLength(50)
          .setPlaceholder("Ketik nama atau username..."),
      ),
    );

  await interaction.showModal(modal);
}

async function handleMemberSearchSubmit(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const query   = interaction.fields.getTextInputValue("query");
  const results = await searchMembers(interaction.guild, query);

  if (results.length === 0) {
    await interaction.editReply({ content: `🔍 Tidak ada member ditemukan: **${query}**` });
    return;
  }

  const fields = results.map((m) => ({
    name: `${m.user.username} (${m.user.id})`,
    value: [
      `Display: ${m.displayName ?? m.user.username}`,
      `Premium: ${premDB.isUserPremium(m.user.id) ? "✅ Ya" : "❌ Tidak"}`,
      `Joined: ${m.joinedAt ? m.joinedAt.toLocaleDateString("id-ID") : "—"}`,
    ].join("\n"),
    inline: true,
  }));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🔍 Hasil: "${query}"`)
        .setDescription(`Ditemukan **${results.length}** member.`)
        .addFields(fields)
        .setFooter({ text: "Pangeran Assistant AI • Member Search" })
        .setTimestamp(),
    ],
  });
}

async function handleMemberExport(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const content    = await exportMemberList(interaction.guild, premDB);
    const stamp      = new Date().toISOString().slice(0, 10);
    const att        = new AttachmentBuilder(Buffer.from(content, "utf8"), { name: `member-list-${stamp}.txt` });
    await interaction.editReply({ content: "📤 Export selesai:", files: [att] });
  } catch (err) {
    await interaction.editReply({ content: `❌ Gagal export: ${err.message.slice(0, 200)}` });
  }
}

async function handleMemberRefresh(interaction) {
  if (await _denyNotStaff(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const stats = await getMemberStats(interaction.guild, premDB);
    const setup  = databaseDB.get();
    const client = interaction.client;

    if (setup.channels.memberList && setup.messages.memberList) {
      const ch  = await client.channels.fetch(setup.channels.memberList).catch(() => null);
      const msg = ch ? await ch.messages.fetch(setup.messages.memberList).catch(() => null) : null;
      if (msg) await msg.edit({ embeds: [buildMemberListEmbed(stats)], components: buildMemberListComponents() });
    }
    await interaction.editReply({ content: "🔄 Panel Member List diperbarui." });
  } catch (err) {
    await interaction.editReply({ content: `❌ Gagal refresh: ${err.message.slice(0, 200)}` });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Handler utama — dipanggil dari src/events/interactionCreate.js
 * untuk semua interaksi dengan customId yang dimulai dengan "db:".
 *
 * @param {import("discord.js").Interaction} interaction
 */
export async function handleDatabaseInteraction(interaction) {
  const id = interaction.customId ?? "";

  try {
    // ── ChannelSelectMenu ──────────────────────────────────────────────────
    if (interaction.isChannelSelectMenu()) {
      if (id === "db:select:category") return await handleCategorySelect(interaction);
      return;
    }

    // ── ModalSubmit ────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      if (id === "db:modal:category")       return await handleCategoryModalSubmit(interaction);
      if (id === "db:modal:github")         return await handleGitHubModalSubmit(interaction);
      if (id === "db:modal:setting")        return await handleSettingModalSubmit(interaction);
      if (id === "db:modal:member:search")  return await handleMemberSearchSubmit(interaction);
      return;
    }

    // ── Button ─────────────────────────────────────────────────────────────
    if (!interaction.isButton()) return;

    // Setup wizard
    if (id === "db:setup:open")            return await handleSetupOpen(interaction);
    if (id === "db:setup:close")           return await handleSetupClose(interaction);
    if (id === "db:setup:cancel")          return await handleSetupClose(interaction);
    if (id === "db:setup:wizard:existing") return await handleSetupWizardExisting(interaction);
    if (id === "db:setup:wizard:new")      return await handleSetupWizardNew(interaction);
    if (id === "db:setup:wizard:create")   return await handleSetupWizardCreate(interaction);

    // Manage
    if (id === "db:manage:edit")           return await handleManageEdit(interaction);
    if (id === "db:manage:repair")         return await handleManageRepair(interaction);
    if (id === "db:manage:reset")          return await handleManageReset(interaction);
    if (id === "db:manage:reset:confirm")  return await handleManageResetConfirm(interaction);
    if (id === "db:manage:reset:cancel")   return await handleManageResetCancel(interaction);
    if (id === "db:manage:github")         return await handleManageGitHub(interaction);
    if (id === "db:manage:github:edit")    return await handleManageGitHubEdit(interaction);

    // Bot Setting
    if (id === "db:panel:setting:edit")    return await handleSettingEdit(interaction);
    if (id === "db:panel:setting:refresh") return await handleSettingRefresh(interaction);

    // Backup
    if (id === "db:panel:backup:backup")     return await handleBackupCreate(interaction);
    if (id === "db:panel:backup:smartclean") return await handleSmartCleanScan(interaction);
    if (id === "db:panel:backup:storage")    return await handleStorageInfo(interaction);
    if (id === "db:panel:backup:refresh")    return await handleBackupRefresh(interaction);
    if (id.startsWith("db:panel:backup:download:"))
      return await handleBackupDownload(interaction, id.slice("db:panel:backup:download:".length));
    if (id.startsWith("db:panel:backup:upload:"))
      return await handleBackupUpload(interaction, id.slice("db:panel:backup:upload:".length));

    // Smart Clean
    if (id === "db:panel:clean:detail")     return await handleCleanDetail(interaction);
    if (id === "db:panel:clean:clean")      return await handleCleanClean(interaction);
    if (id === "db:panel:clean:confirmyes") return await handleCleanConfirmYes(interaction);
    if (id === "db:panel:clean:confirmno")  return await handleCleanConfirmNo(interaction);
    if (id === "db:panel:clean:rescan")     return await handleCleanRescan(interaction);

    // Member List
    if (id === "db:panel:member:view")    return await handleMemberView(interaction);
    if (id === "db:panel:member:search")  return await handleMemberSearch(interaction);
    if (id === "db:panel:member:export")  return await handleMemberExport(interaction);
    if (id === "db:panel:member:refresh") return await handleMemberRefresh(interaction);

  } catch (err) {
    logger.error(`[Database] Error pada "${id}": ${err.message}`);
    await logError({ feature: "Database", reason: err.message, stage: id, user: interaction.user?.id, guild: interaction.guildId, error: err }).catch(() => {});

    // Pastikan interaksi tidak dibiarkan timeout
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ Terjadi kesalahan pada sistem Database.", ephemeral: true });
      } else if (interaction.deferred) {
        await interaction.editReply({ content: "❌ Terjadi kesalahan pada sistem Database." });
      }
    } catch { /* ignore — interaction mungkin sudah expired */ }
  }
}
