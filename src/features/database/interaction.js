/**
 * features/database/interaction.js — Handler semua interaksi DATABASE.
 *
 * Custom ID prefix yang ditangani: "db:"
 *
 * Setup flow:
 *   db:setup:open         — Buka database setup (cek apakah sudah ada)
 *   db:setup:close        — Tutup ephemeral menu
 *   db:setup:cancel       — Batal setup
 *   db:setup:summary      — Tampilkan ringkasan sebelum buat panel
 *   db:setup:confirmcreate— Konfirmasi & buat semua panel
 *   db:setup:edit         — Kembali ke halaman pilih channel
 *   db:setup:rebuild      — Hapus & buat ulang panel
 *   db:setup:delete       — Hapus pesan panel (bukan channel/data)
 *
 * Channel select (ChannelSelectMenu):
 *   db:select:botSetting  — Pilih channel Bot Setting
 *   db:select:backup      — Pilih channel Backup
 *   db:select:console     — Pilih channel Console
 *   db:select:memberList  — Pilih channel Member List
 *
 * Panel Bot Setting:
 *   db:panel:setting:edit     — Buka modal edit pengaturan
 *   db:panel:setting:refresh  — Refresh panel Bot Setting
 *
 * Panel Backup:
 *   db:panel:backup:backup    — Buat backup ZIP
 *   db:panel:backup:smartclean— Jalankan Smart Clean
 *   db:panel:backup:storage   — Tampilkan info storage
 *   db:panel:backup:refresh   — Refresh panel Backup
 *   db:panel:backup:download:<id> — Download ZIP backup
 *   db:panel:backup:upload:<id>   — Upload ke GitHub
 *
 * Panel Smart Clean:
 *   db:panel:clean:detail     — Tampilkan detail scan
 *   db:panel:clean:clean      — Tampilkan konfirmasi bersihkan
 *   db:panel:clean:confirmyes — Eksekusi bersihkan
 *   db:panel:clean:confirmno  — Batal bersihkan
 *   db:panel:clean:rescan     — Scan ulang
 *
 * Panel Member List:
 *   db:panel:member:view      — Lihat daftar member premium
 *   db:panel:member:search    — Buka modal cari member
 *   db:panel:member:export    — Export daftar member sebagai file
 *   db:panel:member:refresh   — Refresh panel Member List
 *
 * Modal submits:
 *   db:modal:setting          — Simpan pengaturan Bot Setting
 *   db:modal:member:search    — Jalankan pencarian member
 */

import {
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  AttachmentBuilder,
} from "discord.js";

import { databaseDB }      from "../../database/databaseDB.js";
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
  // Setup embeds
  buildSetupChannelSelectEmbed,
  buildSetupChannelSelectComponents,
  buildSetupSummaryEmbed,
  buildSetupManageEmbed,
  buildSetupManageComponents,
  // Panel embeds
  buildBotSettingEmbed,
  buildBotSettingComponents,
  buildBackupPanelEmbed,
  buildBackupPanelComponents,
  buildStorageEmbed,
  buildSmartCleanResultEmbed,
  buildSmartCleanResultComponents,
  buildSmartCleanDetailEmbed,
  buildSmartCleanDetailComponents,
  buildCleanConfirmComponents,
  buildBackupActionComponents,
  buildMemberListEmbed,
  buildMemberListComponents,
} from "./embed.js";

// Import PremiumDB singleton
import { premDB } from "../../database/db.js";

// ── In-memory session stores ──────────────────────────────────────────────────

/**
 * Sesi setup: menyimpan pilihan channel sementara per user.
 * Key: userId, Value: { botSetting, backup, console, memberList }
 */
const _setupSessions = new Map();

/**
 * Sesi Smart Clean: menyimpan hasil scan sementara per user.
 * Key: userId, Value: result dari runSmartClean()
 */
const _cleanSessions = new Map();

// ── Helper ────────────────────────────────────────────────────────────────────

/** Balas dengan pesan error singkat jika user bukan staff. */
async function denyIfNotStaffInteraction(interaction) {
  if (isStaff(interaction.member)) return false;
  await interaction.reply({
    content: "❌ Kamu tidak memiliki izin untuk menggunakan fitur ini.",
    ephemeral: true,
  }).catch(() => {});
  return true;
}

/** Dapatkan atau buat sesi setup untuk user. */
function getSession(userId) {
  if (!_setupSessions.has(userId)) {
    _setupSessions.set(userId, { botSetting: null, backup: null, console: null, memberList: null });
  }
  return _setupSessions.get(userId);
}

// ── Setup: Buka Database ──────────────────────────────────────────────────────

async function handleSetupOpen(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;

  if (databaseDB.isSetup()) {
    // Sudah pernah setup — tampilkan menu manage
    await interaction.update({
      embeds:     [buildSetupManageEmbed(databaseDB.get())],
      components: buildSetupManageComponents(),
    });
  } else {
    // Belum setup — mulai flow pilih channel
    const sel = getSession(interaction.user.id);
    await interaction.update({
      embeds:     [buildSetupChannelSelectEmbed(sel)],
      components: buildSetupChannelSelectComponents(sel),
    });
  }
}

// ── Setup: Pilih Channel ──────────────────────────────────────────────────────

async function handleChannelSelect(interaction, panelKey) {
  if (await denyIfNotStaffInteraction(interaction)) return;

  const channelId = interaction.values[0];
  const sel       = getSession(interaction.user.id);
  sel[panelKey]   = channelId;

  await interaction.update({
    embeds:     [buildSetupChannelSelectEmbed(sel)],
    components: buildSetupChannelSelectComponents(sel),
  });
}

// ── Setup: Tampilkan Ringkasan ────────────────────────────────────────────────
// (Tidak dipakai secara langsung lagi — transisi dari channel-select → summary
//  kini dilakukan di dalam blok id === "db:setup:create" di dispatcher)

// ── Setup: Konfirmasi Buat Panel ──────────────────────────────────────────────

async function handleSetupConfirmCreate(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;

  const sel = getSession(interaction.user.id);
  if (!sel.botSetting || !sel.backup || !sel.console || !sel.memberList) {
    await interaction.reply({
      content: "❌ Belum semua channel dipilih.",
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  await interaction.deferUpdate();

  // Simpan ke database
  databaseDB.saveSetup(
    { botSetting: sel.botSetting, backup: sel.backup, console: sel.console, memberList: sel.memberList },
    interaction.guildId,
    interaction.user.id,
  );

  const setup  = databaseDB.get();
  const client = interaction.client;
  const errors = [];

  // ── Kirim panel Bot Setting ─────────────────────────────────────────────
  try {
    const ch  = await client.channels.fetch(setup.channels.botSetting).catch(() => null);
    if (ch?.isTextBased()) {
      const msg = await ch.send({
        embeds:     [buildBotSettingEmbed(client, setup)],
        components: buildBotSettingComponents(),
      });
      databaseDB.setMessage("botSetting", msg.id);
    } else errors.push("⚙️ Bot Setting: channel tidak valid");
  } catch (e) { errors.push(`⚙️ Bot Setting: ${e.message.slice(0, 100)}`); }

  // ── Kirim panel Backup ──────────────────────────────────────────────────
  try {
    const ch  = await client.channels.fetch(setup.channels.backup).catch(() => null);
    if (ch?.isTextBased()) {
      const msg = await ch.send({
        embeds:     [buildBackupPanelEmbed()],
        components: buildBackupPanelComponents(),
      });
      databaseDB.setMessage("backup", msg.id);
    } else errors.push("📦 Backup: channel tidak valid");
  } catch (e) { errors.push(`📦 Backup: ${e.message.slice(0, 100)}`); }

  // ── Kirim log ke Console ────────────────────────────────────────────────
  // (Console tidak pakai panel, hanya menerima pesan log baru)

  // ── Kirim panel Member List ─────────────────────────────────────────────
  try {
    const guild = interaction.guild;
    const stats = await getMemberStats(guild, premDB);
    const ch    = await client.channels.fetch(setup.channels.memberList).catch(() => null);
    if (ch?.isTextBased()) {
      const msg = await ch.send({
        embeds:     [buildMemberListEmbed(stats)],
        components: buildMemberListComponents(),
      });
      databaseDB.setMessage("memberList", msg.id);
    } else errors.push("👥 Member List: channel tidak valid");
  } catch (e) { errors.push(`👥 Member List: ${e.message.slice(0, 100)}`); }

  // Bersihkan sesi
  _setupSessions.delete(interaction.user.id);

  // Log ke console
  consoleLog("db_save", "Setup Database Selesai", `Setup dibuat oleh ${interaction.user.username}`).catch(() => {});

  const resultLines = [
    "✅ **Setup Database berhasil!**",
    "",
    `⚙️ Bot Setting  → <#${setup.channels.botSetting}>`,
    `📦 Backup       → <#${setup.channels.backup}>`,
    `📄 Console      → <#${setup.channels.console}>`,
    `👥 Member List  → <#${setup.channels.memberList}>`,
  ];
  if (errors.length > 0) resultLines.push("", "⚠️ **Peringatan:**", ...errors.map((e) => `• ${e}`));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(errors.length > 0 ? 0xfee75c : 0x57f287)
        .setTitle("📊 Database — Setup Selesai")
        .setDescription(resultLines.join("\n"))
        .setFooter({ text: "Pangeran Assistant AI • Database" })
        .setTimestamp(),
    ],
    components: [],
  });
}

// ── Setup: Edit (kembali ke channel select) ───────────────────────────────────

async function handleSetupEdit(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;

  // Jika sudah setup, isi session dengan nilai yang sudah ada
  if (databaseDB.isSetup()) {
    const setup = databaseDB.get();
    _setupSessions.set(interaction.user.id, { ...setup.channels });
  }

  const sel = getSession(interaction.user.id);
  await interaction.update({
    embeds:     [buildSetupChannelSelectEmbed(sel)],
    components: buildSetupChannelSelectComponents(sel),
  });
}

// ── Setup: Buat Ulang Panel ───────────────────────────────────────────────────

async function handleSetupRebuild(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferUpdate();

  const setup  = databaseDB.get();
  const client = interaction.client;

  if (!setup.channels.botSetting) {
    await interaction.editReply({ content: "❌ Belum ada setup. Gunakan opsi Setup terlebih dahulu.", components: [], embeds: [] });
    return;
  }

  // Hapus pesan lama
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

  const errors = [];

  // Bot Setting
  try {
    const ch = await client.channels.fetch(setup.channels.botSetting).catch(() => null);
    if (ch?.isTextBased()) {
      const freshSetup = databaseDB.get();
      const msg = await ch.send({ embeds: [buildBotSettingEmbed(client, freshSetup)], components: buildBotSettingComponents() });
      databaseDB.setMessage("botSetting", msg.id);
    }
  } catch (e) { errors.push(`⚙️ Bot Setting: ${e.message.slice(0, 100)}`); }

  // Backup
  try {
    const ch = await client.channels.fetch(setup.channels.backup).catch(() => null);
    if (ch?.isTextBased()) {
      const msg = await ch.send({ embeds: [buildBackupPanelEmbed()], components: buildBackupPanelComponents() });
      databaseDB.setMessage("backup", msg.id);
    }
  } catch (e) { errors.push(`📦 Backup: ${e.message.slice(0, 100)}`); }

  // Member List
  try {
    const stats = await getMemberStats(interaction.guild, premDB);
    const ch    = await client.channels.fetch(setup.channels.memberList).catch(() => null);
    if (ch?.isTextBased()) {
      const msg = await ch.send({ embeds: [buildMemberListEmbed(stats)], components: buildMemberListComponents() });
      databaseDB.setMessage("memberList", msg.id);
    }
  } catch (e) { errors.push(`👥 Member List: ${e.message.slice(0, 100)}`); }

  consoleLog("db_save", "Panel Database Dibuat Ulang", `Oleh ${interaction.user.username}`).catch(() => {});

  const freshSetup = databaseDB.get();
  const desc = errors.length > 0
    ? `✅ Panel berhasil dibuat ulang (dengan ${errors.length} error).\n\n${errors.map((e) => `• ${e}`).join("\n")}`
    : "✅ Semua panel berhasil dibuat ulang.";

  await interaction.editReply({
    embeds:     [buildSetupManageEmbed(freshSetup).setDescription(desc)],
    components: buildSetupManageComponents(),
  });
}

// ── Setup: Hapus Panel ────────────────────────────────────────────────────────

async function handleSetupDelete(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferUpdate();

  const setup  = databaseDB.get();
  const client = interaction.client;

  let deleted = 0;
  for (const key of ["botSetting", "backup", "memberList"]) {
    const msgId = setup.messages[key];
    const chId  = setup.channels[key];
    if (!msgId || !chId) continue;
    try {
      const ch  = await client.channels.fetch(chId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(msgId).catch(() => null) : null;
      if (msg) { await msg.delete(); deleted++; }
    } catch { /* ignore — message may already be deleted */ }
  }

  databaseDB.clearMessages();
  consoleLog("db_save", "Panel Database Dihapus", `${deleted} panel dihapus oleh ${interaction.user.username}`).catch(() => {});

  const freshSetup = databaseDB.get();
  await interaction.editReply({
    embeds:     [buildSetupManageEmbed(freshSetup)],
    components: buildSetupManageComponents(),
  });
}

// ── Setup: Tutup ──────────────────────────────────────────────────────────────

async function handleSetupClose(interaction) {
  await interaction.update({
    embeds:     [],
    components: [],
    content:    "✅ Menu ditutup.",
  }).catch(() => {});
}

// ── Panel: Bot Setting — Edit ─────────────────────────────────────────────────

async function handleSettingEdit(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;

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

// ── Modal: Bot Setting Submit ─────────────────────────────────────────────────

async function handleSettingModalSubmit(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const repo       = interaction.fields.getTextInputValue("github_repo").trim() || null;
  const autoBackup = /^ya$/i.test(interaction.fields.getTextInputValue("auto_backup").trim());
  const autoClean  = /^ya$/i.test(interaction.fields.getTextInputValue("auto_clean").trim());

  databaseDB.updateSettings({ repo, autoBackup, autoClean });

  // Refresh panel Bot Setting
  const setup  = databaseDB.get();
  const client = interaction.client;
  await _refreshBotSettingPanel(client, setup);

  consoleLog("db_save", "Pengaturan Bot Diperbarui", `Oleh ${interaction.user.username}`).catch(() => {});
  await interaction.editReply({ content: "✅ Pengaturan berhasil disimpan dan panel diperbarui." });
}

// ── Panel: Bot Setting — Refresh ──────────────────────────────────────────────

async function handleSettingRefresh(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const setup = databaseDB.get();
  await _refreshBotSettingPanel(interaction.client, setup);
  await interaction.editReply({ content: "🔄 Panel Bot Setting diperbarui." });
}

async function _refreshBotSettingPanel(client, setup) {
  if (!setup.channels.botSetting || !setup.messages.botSetting) return;
  try {
    const ch  = await client.channels.fetch(setup.channels.botSetting).catch(() => null);
    const msg = ch ? await ch.messages.fetch(setup.messages.botSetting).catch(() => null) : null;
    if (msg) {
      await msg.edit({
        embeds:     [buildBotSettingEmbed(client, setup)],
        components: buildBotSettingComponents(),
      });
    }
  } catch (e) {
    logger.warn(`[Database] Gagal refresh Bot Setting panel: ${e.message}`);
  }
}

// ── Panel: Backup — Buat Backup ───────────────────────────────────────────────

async function handleBackupCreate(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await createBackupZip();

    consoleLog("backup", "Backup Berhasil Dibuat", `${result.fileName} (${result.sizeStr})`).catch(() => {});

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("💾 Backup Selesai")
          .setDescription(`File backup berhasil dibuat.\n\n📁 **${result.fileName}**\n📏 Ukuran: ${result.sizeStr}`)
          .addFields({ name: "📌 Catatan", value: "File tersedia selama 30 menit. Segera download atau upload ke GitHub.", inline: false })
          .setFooter({ text: "Pangeran Assistant AI • Backup" })
          .setTimestamp(),
      ],
      components: buildBackupActionComponents(result.tmpId),
    });

    // Update info "backup terakhir" di panel Backup
    await _refreshBackupPanel(interaction.client, { lastAt: result.createdAt, lastName: result.fileName, lastSize: result.sizeStr });

  } catch (err) {
    logger.error(`[Database] Backup gagal: ${err.message}`);
    consoleLog("error", "Backup Gagal", err.message).catch(() => {});
    await interaction.editReply({ content: `❌ Backup gagal: ${err.message.slice(0, 200)}` });
  }
}

async function _refreshBackupPanel(client, lastBackup = null) {
  const setup = databaseDB.get();
  if (!setup.channels.backup || !setup.messages.backup) return;
  try {
    const ch  = await client.channels.fetch(setup.channels.backup).catch(() => null);
    const msg = ch ? await ch.messages.fetch(setup.messages.backup).catch(() => null) : null;
    if (msg) {
      await msg.edit({
        embeds:     [buildBackupPanelEmbed(lastBackup)],
        components: buildBackupPanelComponents(),
      });
    }
  } catch (e) {
    logger.warn(`[Database] Gagal refresh Backup panel: ${e.message}`);
  }
}

// ── Panel: Backup — Download ──────────────────────────────────────────────────

async function handleBackupDownload(interaction, tmpId) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const entry = getBackupEntry(tmpId);
  if (!entry) {
    await interaction.editReply({ content: "❌ File backup tidak ditemukan atau sudah kedaluwarsa (lebih dari 30 menit)." });
    return;
  }

  try {
    const attachment = new AttachmentBuilder(entry.filePath, { name: entry.fileName });
    await interaction.editReply({
      content:     `📥 **${entry.fileName}** (${entry.sizeStr})`,
      files:       [attachment],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ Gagal mengirim file: ${err.message.slice(0, 200)}` });
  }
}

// ── Panel: Backup — Upload GitHub ─────────────────────────────────────────────

async function handleBackupUploadGitHub(interaction, tmpId) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await uploadBackupToGitHub(tmpId);
    consoleLog("backup_upload", "Backup Diupload ke GitHub", result.url).catch(() => {});
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
    logger.warn(`[Database] GitHub upload gagal: ${err.message}`);
    await interaction.editReply({
      content: `❌ Upload GitHub gagal: ${err.message.slice(0, 300)}`,
    });
  }
}

// ── Panel: Backup — Smart Clean ───────────────────────────────────────────────

async function handleSmartCleanScan(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const result = runSmartClean();
    _cleanSessions.set(interaction.user.id, result);

    consoleLog("smartclean", "Smart Clean Selesai",
      `${result.safe.length} aman, ${result.review.length} ditinjau, ${result.protected.length} dilindungi`)
      .catch(() => {});

    await interaction.editReply({
      embeds:     [buildSmartCleanResultEmbed(result)],
      components: buildSmartCleanResultComponents(result.safe.length),
    });
  } catch (err) {
    logger.error(`[Database] Smart Clean gagal: ${err.message}`);
    await interaction.editReply({ content: `❌ Smart Clean gagal: ${err.message.slice(0, 200)}` });
  }
}

// ── Panel: Backup — Storage ───────────────────────────────────────────────────

async function handleStorageInfo(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const stats = getStorageStats();
  await interaction.editReply({
    embeds: [buildStorageEmbed(stats)],
  });
}

// ── Panel: Backup — Refresh ───────────────────────────────────────────────────

async function handleBackupRefresh(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });
  await _refreshBackupPanel(interaction.client);
  await interaction.editReply({ content: "🔄 Panel Backup diperbarui." });
}

// ── Panel: Smart Clean — Detail ───────────────────────────────────────────────

async function handleCleanDetail(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;

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

// ── Panel: Smart Clean — Bersihkan ───────────────────────────────────────────

async function handleCleanClean(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;

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
          `Apakah kamu yakin ingin menghapus **${result.safe.length} item** (${result.totalSafeSizeStr})?\n\n` +
          "Hanya file kategori 🟢 **Aman** yang akan dihapus.\n" +
          "File penting, database, dan source code **tidak akan tersentuh**.",
        )
        .setFooter({ text: "Pangeran Assistant AI • Smart Clean" })
        .setTimestamp(),
    ],
    components: buildCleanConfirmComponents(),
  });
}

// ── Panel: Smart Clean — Konfirmasi Ya ───────────────────────────────────────

async function handleCleanConfirmYes(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferUpdate();

  const result = _cleanSessions.get(interaction.user.id);
  if (!result) {
    await interaction.editReply({ content: "❌ Sesi Smart Clean tidak ditemukan.", embeds: [], components: [] });
    return;
  }

  const cleanResult = executeClean(result.safe);
  _cleanSessions.delete(interaction.user.id);

  consoleLog("cleaned", "Smart Clean Berhasil",
    `${cleanResult.deleted} item dihapus, ${cleanResult.freedStr} dibebaskan`)
    .catch(() => {});

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("🧹 Bersihkan Selesai")
        .setDescription(
          `✅ **${cleanResult.deleted} item** berhasil dihapus.\n` +
          `💾 Ruang dibebaskan: **${cleanResult.freedStr}**`,
        )
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

// ── Panel: Smart Clean — Konfirmasi Tidak ────────────────────────────────────

async function handleCleanConfirmNo(interaction) {
  const result = _cleanSessions.get(interaction.user.id);
  if (result) {
    // Kembali ke hasil scan
    await interaction.update({
      embeds:     [buildSmartCleanResultEmbed(result)],
      components: buildSmartCleanResultComponents(result.safe.length),
    });
  } else {
    await interaction.update({ content: "❌ Batal.", embeds: [], components: [] });
  }
}

// ── Panel: Smart Clean — Scan Ulang ──────────────────────────────────────────

async function handleCleanRescan(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferUpdate();

  const result = runSmartClean();
  _cleanSessions.set(interaction.user.id, result);

  consoleLog("smartclean", "Smart Clean Dijalankan Ulang",
    `${result.safe.length} aman, ${result.review.length} ditinjau`)
    .catch(() => {});

  await interaction.editReply({
    embeds:     [buildSmartCleanResultEmbed(result)],
    components: buildSmartCleanResultComponents(result.safe.length),
  });
}

// ── Panel: Member List — Lihat ────────────────────────────────────────────────

async function handleMemberView(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const stats = await getMemberStats(interaction.guild, premDB);

    // Tampilkan daftar premium users
    const premUsers = premDB.getAllPremiumUsers().filter((u) => {
      if (!u.expiresAt) return true;
      return new Date(u.expiresAt) > new Date();
    });

    const lines = premUsers.slice(0, 20).map((u) => {
      const exp = u.expiresAt
        ? `exp: ${new Date(u.expiresAt).toLocaleDateString("id-ID")}`
        : "permanent";
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
            { name: "👑 Total Premium", value: `${stats.premium}`, inline: true },
            { name: "🔱 CEO",           value: `${stats.ceo}`,     inline: true },
            { name: "👥 Total Member",  value: `${stats.total}`,   inline: true },
          )
          .setFooter({ text: "Pangeran Assistant AI • Member List" })
          .setTimestamp(),
      ],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ Gagal memuat daftar member: ${err.message.slice(0, 200)}` });
  }
}

// ── Panel: Member List — Cari ─────────────────────────────────────────────────

async function handleMemberSearch(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;

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

// ── Modal: Member Search Submit ───────────────────────────────────────────────

async function handleMemberSearchSubmit(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const query   = interaction.fields.getTextInputValue("query");
  const results = await searchMembers(interaction.guild, query);

  if (results.length === 0) {
    await interaction.editReply({ content: `🔍 Tidak ada member ditemukan untuk kueri: **${query}**` });
    return;
  }

  const fields = results.map((m) => ({
    name:  `${m.user.username} (${m.user.id})`,
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
        .setTitle(`🔍 Hasil Pencarian: "${query}"`)
        .setDescription(`Ditemukan **${results.length}** member.`)
        .addFields(fields)
        .setFooter({ text: "Pangeran Assistant AI • Member Search" })
        .setTimestamp(),
    ],
  });
}

// ── Panel: Member List — Export ───────────────────────────────────────────────

async function handleMemberExport(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const content    = await exportMemberList(interaction.guild, premDB);
    const buffer     = Buffer.from(content, "utf8");
    const stamp      = new Date().toISOString().slice(0, 10);
    const attachment = new AttachmentBuilder(buffer, { name: `member-list-${stamp}.txt` });

    await interaction.editReply({
      content: "📤 Export daftar member selesai:",
      files:   [attachment],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ Gagal export: ${err.message.slice(0, 200)}` });
  }
}

// ── Panel: Member List — Refresh ──────────────────────────────────────────────

async function handleMemberRefresh(interaction) {
  if (await denyIfNotStaffInteraction(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const stats  = await getMemberStats(interaction.guild, premDB);
    const setup  = databaseDB.get();
    const client = interaction.client;

    if (setup.channels.memberList && setup.messages.memberList) {
      const ch  = await client.channels.fetch(setup.channels.memberList).catch(() => null);
      const msg = ch ? await ch.messages.fetch(setup.messages.memberList).catch(() => null) : null;
      if (msg) {
        await msg.edit({
          embeds:     [buildMemberListEmbed(stats)],
          components: buildMemberListComponents(),
        });
      }
    }

    await interaction.editReply({ content: "🔄 Panel Member List diperbarui." });
  } catch (err) {
    await interaction.editReply({ content: `❌ Gagal refresh: ${err.message.slice(0, 200)}` });
  }
}

// ── Main Dispatcher ───────────────────────────────────────────────────────────

/**
 * Handler utama untuk semua interaksi dengan prefix "db:".
 * Dipanggil dari src/events/interactionCreate.js.
 *
 * @param {import("discord.js").Interaction} interaction
 */
export async function handleDatabaseInteraction(interaction) {
  const id = interaction.customId ?? "";

  try {
    // ── Channel Select Menu ────────────────────────────────────────────────
    if (interaction.isChannelSelectMenu()) {
      if (id === "db:select:botSetting") return await handleChannelSelect(interaction, "botSetting");
      if (id === "db:select:backup")     return await handleChannelSelect(interaction, "backup");
      if (id === "db:select:console")    return await handleChannelSelect(interaction, "console");
      if (id === "db:select:memberList") return await handleChannelSelect(interaction, "memberList");
      return;
    }

    // ── Modal Submit ───────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      if (id === "db:modal:setting")        return await handleSettingModalSubmit(interaction);
      if (id === "db:modal:member:search")  return await handleMemberSearchSubmit(interaction);
      return;
    }

    // ── Buttons ───────────────────────────────────────────────────────────
    if (!interaction.isButton()) return;

    // Setup flow
    if (id === "db:setup:open")          return await handleSetupOpen(interaction);
    if (id === "db:setup:close")         return await handleSetupClose(interaction);
    if (id === "db:setup:cancel")        return await handleSetupClose(interaction);
    if (id === "db:setup:summary")       return await handleSetupSummary(interaction);
    if (id === "db:setup:confirmcreate") return await handleSetupConfirmCreate(interaction);
    if (id === "db:setup:edit")          return await handleSetupEdit(interaction);
    if (id === "db:setup:rebuild")       return await handleSetupRebuild(interaction);
    if (id === "db:setup:delete")        return await handleSetupDelete(interaction);

    // "Buat Panel" dari channel-select screen → tampilkan ringkasan konfirmasi
    if (id === "db:setup:create") {
      if (await denyIfNotStaffInteraction(interaction)) return;
      const sel = getSession(interaction.user.id);
      const allSelected = sel.botSetting && sel.backup && sel.console && sel.memberList;
      if (!allSelected) {
        await interaction.reply({ content: "❌ Belum semua channel dipilih.", ephemeral: true }).catch(() => {});
        return;
      }
      await interaction.update({
        embeds: [buildSetupSummaryEmbed(sel)],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("db:setup:confirmcreate").setLabel("✅ Buat Panel").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("db:setup:edit").setLabel("✏️ Edit").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("db:setup:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Danger),
          ),
        ],
      });
      return;
    }

    // Bot Setting
    if (id === "db:panel:setting:edit")    return await handleSettingEdit(interaction);
    if (id === "db:panel:setting:refresh") return await handleSettingRefresh(interaction);

    // Backup
    if (id === "db:panel:backup:backup")     return await handleBackupCreate(interaction);
    if (id === "db:panel:backup:smartclean") return await handleSmartCleanScan(interaction);
    if (id === "db:panel:backup:storage")    return await handleStorageInfo(interaction);
    if (id === "db:panel:backup:refresh")    return await handleBackupRefresh(interaction);

    // Backup: Download / Upload (ID dinamis)
    if (id.startsWith("db:panel:backup:download:")) {
      return await handleBackupDownload(interaction, id.slice("db:panel:backup:download:".length));
    }
    if (id.startsWith("db:panel:backup:upload:")) {
      return await handleBackupUploadGitHub(interaction, id.slice("db:panel:backup:upload:".length));
    }

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
    logger.error(`[Database] Interaction error untuk "${id}": ${err.message}`);
    await logError({
      feature: "Database",
      reason:  err.message,
      stage:   id,
      user:    interaction.user?.id,
      guild:   interaction.guildId,
      error:   err,
    }).catch(() => {});

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Terjadi kesalahan pada sistem Database.", ephemeral: true }).catch(() => {});
    }
  }
}
