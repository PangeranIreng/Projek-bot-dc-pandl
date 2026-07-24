/**
 * src/features/setup/adminSetup.js — Panel Admin terpusat untuk seluruh konfigurasi bot.
 *
 * Menangani semua interaksi dengan prefix "setup:".
 *
 * Routing:
 *   setup:main                          → Panel utama (menu kategori)
 *
 *   setup:ticket:main                   → Panel konfigurasi Ticket
 *   setup:ticket:panel                  → Pilih channel panel Ticket
 *   setup:ticket:panel:select           → ChannelSelectMenu result (panel)
 *   setup:ticket:panel:save:<id>        → Simpan & kirim panel Ticket
 *   setup:ticket:logs                   → Pilih channel log Ticket
 *   setup:ticket:logs:select            → ChannelSelectMenu result (logs)
 *   setup:ticket:logs:save:<id>         → Simpan log channel
 *   setup:ticket:mention                → Pilih mention role
 *   setup:ticket:mention:select         → RoleSelectMenu result
 *   setup:ticket:claim                  → Pilih claim channel
 *   setup:ticket:claim:select           → ChannelSelectMenu result (claim ch)
 *   setup:ticket:claim:save:<id>        → Simpan claim channel, lanjut ke role
 *   setup:ticket:claimrole              → Pilih claim role
 *   setup:ticket:claimrole:select       → RoleSelectMenu result
 *   setup:ticket:delete                 → Konfirmasi hapus Ticket
 *   setup:ticket:delete:confirm         → Hapus Ticket
 *   setup:ticket:delete:cancel          → Batal hapus
 *
 *   setup:bug:main                      → Panel konfigurasi Bug & Feature
 *   setup:bug:panel                     → Pilih channel panel Bug
 *   setup:bug:panel:select              → ChannelSelectMenu result
 *   setup:bug:panel:save:<id>           → Simpan & kirim panel Bug
 *   setup:bug:logs                      → Pilih channel log Bug
 *   setup:bug:logs:select               → ChannelSelectMenu result
 *   setup:bug:logs:save:<id>            → Simpan log channel
 *   setup:bug:role                      → Pilih developer role
 *   setup:bug:role:select               → RoleSelectMenu result
 *   setup:bug:delete                    → Konfirmasi hapus Bug setup
 *   setup:bug:delete:confirm            → Hapus Bug setup
 *   setup:bug:delete:cancel             → Batal hapus
 *
 *   setup:prem:main                     → Panel Premium Stats
 *   setup:prem:channel                  → Pilih channel Premium Stats
 *   setup:prem:channel:select           → ChannelSelectMenu result
 *   setup:prem:channel:save:<id>        → Simpan & buat panel
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
} from "discord.js";

import { ticketDB }    from "../../database/ticketDB.js";
import { bugReportDB } from "../../database/bugReportDB.js";
import { premDB, db, ltDB } from "../../database/db.js";
import { databaseDB }       from "../../database/databaseDB.js";
import { isStaff, isOwner } from "../../middleware/permissions.js";
import { logger }      from "../../utils/logger.js";
import { sendTicketPanel }        from "../ticket/handler.js";
import { updateTicketDashboard }  from "../ticket/dashboard.js";
import { sendBugPanel }           from "../bugreport/handler.js";
import { buildBugPanelEmbed, buildBugPanelButtonRow } from "../bugreport/embed.js";
import { updatePremStatsDashboard } from "../premium/statsDashboard.js";

const FOOTER = "Pangeran Assistant AI • Admin Setup";
const COLOR = {
  BLUE:   0x5865f2,
  GREEN:  0x57f287,
  RED:    0xed4245,
  YELLOW: 0xfee75c,
};

// ── In-memory wizard sessions ─────────────────────────────────────────────────
// userId → { ticketClaimChannelId, bugPanelChannelId, premChannelId, ... }
const _sessions = new Map();
function _session(userId) {
  if (!_sessions.has(userId)) _sessions.set(userId, {});
  return _sessions.get(userId);
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

async function _denyNotStaff(interaction) {
  if (isStaff(interaction.member)) return false;
  const fn = (interaction.deferred || interaction.replied) ? "editReply" : "reply";
  await interaction[fn]({ content: "❌ Kamu tidak memiliki izin menggunakan fitur ini.", ephemeral: true }).catch(() => {});
  return true;
}

async function _denyNotOwner(interaction) {
  if (isOwner(interaction.member)) return false;
  const fn = (interaction.deferred || interaction.replied) ? "editReply" : "reply";
  await interaction[fn]({ content: "❌ Hanya Owner yang dapat menggunakan fitur ini.", ephemeral: true }).catch(() => {});
  return true;
}

function _backRow(label = "🔙 Kembali ke Menu Utama") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("setup:main")
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary),
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN PANEL
// ════════════════════════════════════════════════════════════════════════════

function _buildMainEmbed() {
  const tc  = ticketDB.getConfig();
  const bc  = bugReportDB.getConfig();
  const bdb = databaseDB.isSetup();
  const bbm = db.isConfigured();
  const ltm = ltDB.isAnyConfigured();
  const ps  = premDB.getPremStatsDashboardState();

  const status = (ok) => ok ? "🟢 Dikonfigurasi" : "🔴 Belum diatur";

  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("⚙️ Panel Admin — Konfigurasi Bot")
    .setDescription(
      "Pilih sistem yang ingin dikonfigurasi.\n\n" +
      "Setiap kategori membuka panel konfigurasi lengkap dengan tombol interaktif.\n"
    )
    .addFields(
      { name: "📊 Database",       value: status(bdb), inline: true },
      { name: "🎵 BoomBox",        value: status(bbm), inline: true },
      { name: "📜 Lua Tools",      value: status(ltm), inline: true },
      { name: "🎫 Ticket",         value: status(tc.panelChannelId), inline: true },
      { name: "🐞 Bug & Feature",  value: status(bc.panelChannelId), inline: true },
      { name: "👑 Premium Stats",  value: status(ps?.channelId),     inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function _buildMainComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("db:setup:open").setLabel("📊 Database").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("bbsetup:back").setLabel("🎵 BoomBox").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ltsetup:view").setLabel("📜 Lua Tools").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup:ticket:main").setLabel("🎫 Ticket").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:bug:main").setLabel("🐞 Bug & Feature").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:prem:main").setLabel("👑 Premium Stats").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup:close").setLabel("❌ Tutup").setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// TICKET CONFIG PANEL
// ════════════════════════════════════════════════════════════════════════════

function _buildTicketEmbed() {
  const cfg = ticketDB.getConfig();
  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("🎫 Konfigurasi Ticket System")
    .setDescription("Atur channel, role, dan pengaturan sistem Open Ticket.")
    .addFields(
      { name: "📺 Panel Channel",     value: cfg.panelChannelId  ? `<#${cfg.panelChannelId}>`  : "❌ Belum diatur", inline: true },
      { name: "📋 Log Channel",       value: cfg.logsChannelId   ? `<#${cfg.logsChannelId}>`   : "❌ Belum diatur", inline: true },
      { name: "🔔 Mention Role",      value: cfg.mentionRoleId   ? `<@&${cfg.mentionRoleId}>`  : "❌ Belum diatur", inline: true },
      { name: "🎫 Claim Channel",     value: cfg.claimChannelId  ? `<#${cfg.claimChannelId}>`  : "❌ Belum diatur", inline: true },
      { name: "🔔 Claim Role",        value: cfg.claimRoleId     ? `<@&${cfg.claimRoleId}>`    : "❌ Belum diatur", inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function _buildTicketComponents(hasConfig) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup:ticket:panel").setLabel("📺 Panel Channel").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup:ticket:logs").setLabel("📋 Log Channel").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup:ticket:mention").setLabel("🔔 Mention Role").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup:ticket:claim").setLabel("🎫 Claim Channel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:ticket:claimrole").setLabel("🔔 Claim Role").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup:main").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
      ...(hasConfig
        ? [new ButtonBuilder().setCustomId("setup:ticket:delete").setLabel("🗑 Hapus Setup").setStyle(ButtonStyle.Danger)]
        : []),
    ),
  ];
  return rows;
}

// ════════════════════════════════════════════════════════════════════════════
// BUG REPORT CONFIG PANEL
// ════════════════════════════════════════════════════════════════════════════

function _buildBugEmbed() {
  const cfg = bugReportDB.getConfig();
  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("🐞 Konfigurasi Bug & Feature Report")
    .setDescription("Atur channel, role, dan pengaturan sistem Bug Report & Feature Request.")
    .addFields(
      { name: "📺 Panel Channel",  value: cfg.panelChannelId  ? `<#${cfg.panelChannelId}>`  : "❌ Belum diatur", inline: true },
      { name: "📋 Log Channel",    value: cfg.logsChannelId   ? `<#${cfg.logsChannelId}>`   : "❌ Belum diatur", inline: true },
      { name: "👤 Dev Role",       value: cfg.developerRoleId ? `<@&${cfg.developerRoleId}>` : "❌ Belum diatur", inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function _buildBugComponents(hasConfig) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup:bug:panel").setLabel("📺 Panel Channel").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup:bug:logs").setLabel("📋 Log Channel").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup:bug:role").setLabel("👤 Dev Role").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup:main").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
      ...(hasConfig
        ? [new ButtonBuilder().setCustomId("setup:bug:delete").setLabel("🗑 Hapus Setup").setStyle(ButtonStyle.Danger)]
        : []),
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// PREMIUM STATS PANEL
// ════════════════════════════════════════════════════════════════════════════

function _buildPremEmbed() {
  const state = premDB.getPremStatsDashboardState();
  return new EmbedBuilder()
    .setColor(COLOR.BLUE)
    .setTitle("👑 Konfigurasi Premium Statistics")
    .setDescription(
      "Panel Premium Statistics menampilkan statistik premium secara real-time.\n\n" +
      "Pilih channel tempat panel akan dikirim. Panel akan diperbarui otomatis setiap ada perubahan premium."
    )
    .addFields(
      { name: "📺 Channel",   value: state?.channelId ? `<#${state.channelId}>` : "❌ Belum diatur", inline: true },
      { name: "💬 Panel",     value: state?.messageId ? "✅ Aktif" : "❌ Belum ada", inline: true },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function _buildPremComponents(hasState) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup:prem:channel").setLabel("📺 Pilih Channel").setStyle(ButtonStyle.Primary),
      ...(hasState
        ? [new ButtonBuilder().setCustomId("setup:prem:refresh").setLabel("🔄 Refresh Panel").setStyle(ButtonStyle.Secondary)]
        : []),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup:main").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Handle all interactions whose customId starts with "setup:".
 * @param {import("discord.js").Interaction} interaction
 */
export async function handleAdminSetupInteraction(interaction) {
  const id = interaction.customId ?? "";

  try {

    // ── Tutup ──────────────────────────────────────────────────────────────
    if (id === "setup:close") {
      await interaction.update({ content: "✅ Panel ditutup.", embeds: [], components: [] }).catch(() => {});
      return;
    }

    // ── Menu Utama ─────────────────────────────────────────────────────────
    if (id === "setup:main") {
      await interaction.update({
        embeds:     [_buildMainEmbed()],
        components: _buildMainComponents(),
      });
      return;
    }

    // ════════════════════════════════════════════════════════════════════════
    // TICKET
    // ════════════════════════════════════════════════════════════════════════

    if (id === "setup:ticket:main") {
      if (await _denyNotStaff(interaction)) return;
      const cfg = ticketDB.getConfig();
      await interaction.update({
        embeds:     [_buildTicketEmbed()],
        components: _buildTicketComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ── Panel Channel ──────────────────────────────────────────────────────

    if (id === "setup:ticket:panel") {
      if (await _denyNotStaff(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.BLUE)
            .setTitle("🎫 Ticket — Pilih Panel Channel")
            .setDescription("Pilih channel tempat panel **Open Ticket** akan dikirim.")
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("setup:ticket:panel:select")
              .setPlaceholder("📺 Pilih channel panel...")
              .addChannelTypes(ChannelType.GuildText),
          ),
          _backRow("🔙 Kembali ke Ticket"),
        ],
      });
      return;
    }

    if (id === "setup:ticket:panel:select" && interaction.isChannelSelectMenu()) {
      if (await _denyNotStaff(interaction)) return;
      const channelId = interaction.values[0];
      _session(interaction.user.id).ticketPanelChannelId = channelId;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.YELLOW)
            .setTitle("🎫 Ticket — Konfirmasi Panel Channel")
            .setDescription(`Channel dipilih: <#${channelId}>\n\nKlik **Simpan** untuk mengirim panel Open Ticket ke channel ini.`)
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`setup:ticket:panel:save:${channelId}`).setLabel("💾 Simpan & Kirim Panel").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("setup:ticket:panel").setLabel("↩ Pilih Ulang").setStyle(ButtonStyle.Secondary),
          ),
          _backRow("🔙 Kembali ke Ticket"),
        ],
      });
      return;
    }

    const ticketPanelSave = /^setup:ticket:panel:save:(\d+)$/.exec(id);
    if (ticketPanelSave) {
      if (await _denyNotStaff(interaction)) return;
      await interaction.deferUpdate();
      const channelId = ticketPanelSave[1];
      ticketDB.setConfig({ panelChannelId: channelId });
      try {
        const ch = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (ch?.isTextBased()) {
          const cfg = ticketDB.getConfig();
          if (cfg.panelMessageId) {
            const oldMsg = await ch.messages.fetch(cfg.panelMessageId).catch(() => null);
            if (oldMsg) await oldMsg.delete().catch(() => {});
          }
          const panelMsg = await sendTicketPanel(ch);
          ticketDB.setConfig({ panelMessageId: panelMsg.id });
        }
      } catch (e) {
        logger.warn(`[Setup] Gagal kirim panel Ticket: ${e.message}`);
      }
      const cfg = ticketDB.getConfig();
      await interaction.editReply({
        embeds:     [_buildTicketEmbed().setDescription(`✅ Panel Ticket dikirim ke <#${channelId}>`)],
        components: _buildTicketComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ── Logs Channel ──────────────────────────────────────────────────────

    if (id === "setup:ticket:logs") {
      if (await _denyNotStaff(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.BLUE)
            .setTitle("🎫 Ticket — Pilih Log Channel")
            .setDescription("Pilih channel tempat **Dashboard Ticket Logs** ditampilkan.")
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("setup:ticket:logs:select")
              .setPlaceholder("📋 Pilih channel log...")
              .addChannelTypes(ChannelType.GuildText),
          ),
          _backRow("🔙 Kembali ke Ticket"),
        ],
      });
      return;
    }

    if (id === "setup:ticket:logs:select" && interaction.isChannelSelectMenu()) {
      if (await _denyNotStaff(interaction)) return;
      const channelId = interaction.values[0];
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.YELLOW)
            .setTitle("🎫 Ticket — Konfirmasi Log Channel")
            .setDescription(`Channel dipilih: <#${channelId}>\n\nKlik **Simpan** untuk mengatur log Ticket ke channel ini.`)
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`setup:ticket:logs:save:${channelId}`).setLabel("💾 Simpan").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("setup:ticket:logs").setLabel("↩ Pilih Ulang").setStyle(ButtonStyle.Secondary),
          ),
          _backRow("🔙 Kembali ke Ticket"),
        ],
      });
      return;
    }

    const ticketLogsSave = /^setup:ticket:logs:save:(\d+)$/.exec(id);
    if (ticketLogsSave) {
      if (await _denyNotStaff(interaction)) return;
      await interaction.deferUpdate();
      const channelId = ticketLogsSave[1];
      ticketDB.setConfig({ logsChannelId: channelId });
      await updateTicketDashboard(interaction.client).catch(() => {});
      const cfg = ticketDB.getConfig();
      await interaction.editReply({
        embeds:     [_buildTicketEmbed().setDescription(`✅ Log Ticket diatur ke <#${channelId}>`)],
        components: _buildTicketComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ── Mention Role ──────────────────────────────────────────────────────

    if (id === "setup:ticket:mention") {
      if (await _denyNotStaff(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.BLUE)
            .setTitle("🎫 Ticket — Pilih Mention Role")
            .setDescription("Pilih role yang akan di-mention saat Ticket baru dibuat.")
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId("setup:ticket:mention:select")
              .setPlaceholder("🔔 Pilih role mention..."),
          ),
          _backRow("🔙 Kembali ke Ticket"),
        ],
      });
      return;
    }

    if (id === "setup:ticket:mention:select" && interaction.isRoleSelectMenu()) {
      if (await _denyNotStaff(interaction)) return;
      const roleId = interaction.values[0];
      ticketDB.setConfig({ mentionRoleId: roleId });
      const cfg = ticketDB.getConfig();
      await interaction.update({
        embeds:     [_buildTicketEmbed().setDescription(`✅ Mention role diatur ke <@&${roleId}>`)],
        components: _buildTicketComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ── Claim Channel ─────────────────────────────────────────────────────

    if (id === "setup:ticket:claim") {
      if (await _denyNotStaff(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.BLUE)
            .setTitle("🎫 Ticket — Pilih Claim Channel")
            .setDescription("Pilih channel Staff Control tempat notifikasi dan tombol Ticket dikirim.")
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("setup:ticket:claim:select")
              .setPlaceholder("🎫 Pilih channel claim...")
              .addChannelTypes(ChannelType.GuildText),
          ),
          _backRow("🔙 Kembali ke Ticket"),
        ],
      });
      return;
    }

    if (id === "setup:ticket:claim:select" && interaction.isChannelSelectMenu()) {
      if (await _denyNotStaff(interaction)) return;
      const channelId = interaction.values[0];
      _session(interaction.user.id).ticketClaimChannelId = channelId;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.YELLOW)
            .setTitle("🎫 Ticket — Konfirmasi Claim Channel")
            .setDescription(`Channel dipilih: <#${channelId}>\n\nKlik **Simpan** untuk menyimpan.`)
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`setup:ticket:claim:save:${channelId}`).setLabel("💾 Simpan").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("setup:ticket:claim").setLabel("↩ Pilih Ulang").setStyle(ButtonStyle.Secondary),
          ),
          _backRow("🔙 Kembali ke Ticket"),
        ],
      });
      return;
    }

    const ticketClaimSave = /^setup:ticket:claim:save:(\d+)$/.exec(id);
    if (ticketClaimSave) {
      if (await _denyNotStaff(interaction)) return;
      const channelId = ticketClaimSave[1];
      ticketDB.setConfig({ claimChannelId: channelId });
      const cfg = ticketDB.getConfig();
      await interaction.update({
        embeds:     [_buildTicketEmbed().setDescription(`✅ Claim channel diatur ke <#${channelId}>`)],
        components: _buildTicketComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ── Claim Role ─────────────────────────────────────────────────────────

    if (id === "setup:ticket:claimrole") {
      if (await _denyNotStaff(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.BLUE)
            .setTitle("🎫 Ticket — Pilih Claim Role")
            .setDescription("Pilih role yang di-mention di notifikasi Staff Control.")
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId("setup:ticket:claimrole:select")
              .setPlaceholder("🔔 Pilih claim role..."),
          ),
          _backRow("🔙 Kembali ke Ticket"),
        ],
      });
      return;
    }

    if (id === "setup:ticket:claimrole:select" && interaction.isRoleSelectMenu()) {
      if (await _denyNotStaff(interaction)) return;
      const roleId = interaction.values[0];
      ticketDB.setConfig({ claimRoleId: roleId });
      const cfg = ticketDB.getConfig();
      await interaction.update({
        embeds:     [_buildTicketEmbed().setDescription(`✅ Claim role diatur ke <@&${roleId}>`)],
        components: _buildTicketComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ── Delete Ticket Setup ───────────────────────────────────────────────

    if (id === "setup:ticket:delete") {
      if (await _denyNotOwner(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.RED)
            .setTitle("⚠️ Konfirmasi Hapus Setup Ticket")
            .setDescription(
              "Tindakan ini akan menghapus:\n" +
              "✔ Panel Open Ticket\n✔ Dashboard Ticket Logs\n✔ Seluruh konfigurasi Ticket\n\n" +
              "Riwayat tiket **tidak** dihapus.\n\n" +
              "⚠️ Apakah kamu yakin?"
            )
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("setup:ticket:delete:confirm").setLabel("✅ Ya, Hapus").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("setup:ticket:delete:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    }

    if (id === "setup:ticket:delete:confirm") {
      if (await _denyNotOwner(interaction)) return;
      await interaction.deferUpdate();
      const cfg = ticketDB.getConfig();
      if (cfg.panelChannelId && cfg.panelMessageId) {
        try {
          const ch  = await interaction.client.channels.fetch(cfg.panelChannelId).catch(() => null);
          const msg = ch ? await ch.messages.fetch(cfg.panelMessageId).catch(() => null) : null;
          if (msg) await msg.delete().catch(() => {});
        } catch { /* abaikan */ }
      }
      if (cfg.logsChannelId && cfg.dashboardMessageId) {
        try {
          const ch  = await interaction.client.channels.fetch(cfg.logsChannelId).catch(() => null);
          const msg = ch ? await ch.messages.fetch(cfg.dashboardMessageId).catch(() => null) : null;
          if (msg) await msg.delete().catch(() => {});
        } catch { /* abaikan */ }
      }
      ticketDB.resetConfig();
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.GREEN)
            .setTitle("✅ Setup Ticket Dihapus")
            .setDescription("Seluruh konfigurasi Ticket berhasil dihapus.\n\nJalankan `/setup` → 🎫 Ticket untuk mengatur ulang.")
            .setFooter({ text: FOOTER }),
        ],
        components: [_backRow()],
      });
      return;
    }

    if (id === "setup:ticket:delete:cancel") {
      if (await _denyNotStaff(interaction)) return;
      const cfg = ticketDB.getConfig();
      await interaction.update({
        embeds:     [_buildTicketEmbed()],
        components: _buildTicketComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ════════════════════════════════════════════════════════════════════════
    // BUG REPORT
    // ════════════════════════════════════════════════════════════════════════

    if (id === "setup:bug:main") {
      if (await _denyNotOwner(interaction)) return;
      const cfg = bugReportDB.getConfig();
      await interaction.update({
        embeds:     [_buildBugEmbed()],
        components: _buildBugComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ── Bug Panel Channel ─────────────────────────────────────────────────

    if (id === "setup:bug:panel") {
      if (await _denyNotOwner(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.BLUE)
            .setTitle("🐞 Bug & Feature — Pilih Panel Channel")
            .setDescription("Pilih channel tempat panel **Bug Report & Feature Request** dikirim.")
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("setup:bug:panel:select")
              .setPlaceholder("📺 Pilih channel panel...")
              .addChannelTypes(ChannelType.GuildText),
          ),
          _backRow("🔙 Kembali ke Bug & Feature"),
        ],
      });
      return;
    }

    if (id === "setup:bug:panel:select" && interaction.isChannelSelectMenu()) {
      if (await _denyNotOwner(interaction)) return;
      const channelId = interaction.values[0];
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.YELLOW)
            .setTitle("🐞 Bug & Feature — Konfirmasi Panel Channel")
            .setDescription(`Channel dipilih: <#${channelId}>\n\nKlik **Simpan** untuk mengirim panel Bug & Feature ke channel ini.`)
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`setup:bug:panel:save:${channelId}`).setLabel("💾 Simpan & Kirim Panel").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("setup:bug:panel").setLabel("↩ Pilih Ulang").setStyle(ButtonStyle.Secondary),
          ),
          _backRow("🔙 Kembali ke Bug & Feature"),
        ],
      });
      return;
    }

    const bugPanelSave = /^setup:bug:panel:save:(\d+)$/.exec(id);
    if (bugPanelSave) {
      if (await _denyNotOwner(interaction)) return;
      await interaction.deferUpdate();
      const channelId = bugPanelSave[1];
      bugReportDB.setConfig({ panelChannelId: channelId });
      try {
        const ch  = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (ch?.isTextBased()) {
          const cfg = bugReportDB.getConfig();
          if (cfg.panelMessageId) {
            const oldMsg = await ch.messages.fetch(cfg.panelMessageId).catch(() => null);
            if (oldMsg) {
              await oldMsg.edit({ embeds: [buildBugPanelEmbed()], components: [buildBugPanelButtonRow()] }).catch(() => {
                // Jika edit gagal, kirim baru
                sendBugPanel(ch).then(msg => bugReportDB.setConfig({ panelMessageId: msg.id })).catch(() => {});
              });
            } else {
              const panelMsg = await sendBugPanel(ch);
              bugReportDB.setConfig({ panelMessageId: panelMsg.id });
            }
          } else {
            const panelMsg = await sendBugPanel(ch);
            bugReportDB.setConfig({ panelMessageId: panelMsg.id });
          }
        }
      } catch (e) {
        logger.warn(`[Setup] Gagal kirim panel Bug: ${e.message}`);
      }
      const cfg = bugReportDB.getConfig();
      await interaction.editReply({
        embeds:     [_buildBugEmbed().setDescription(`✅ Panel Bug & Feature dikirim ke <#${channelId}>`)],
        components: _buildBugComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ── Bug Log Channel ───────────────────────────────────────────────────

    if (id === "setup:bug:logs") {
      if (await _denyNotOwner(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.BLUE)
            .setTitle("🐞 Bug & Feature — Pilih Log Channel")
            .setDescription("Pilih channel tempat semua laporan Bug & Feature masuk.")
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("setup:bug:logs:select")
              .setPlaceholder("📋 Pilih channel log...")
              .addChannelTypes(ChannelType.GuildText),
          ),
          _backRow("🔙 Kembali ke Bug & Feature"),
        ],
      });
      return;
    }

    if (id === "setup:bug:logs:select" && interaction.isChannelSelectMenu()) {
      if (await _denyNotOwner(interaction)) return;
      const channelId = interaction.values[0];
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.YELLOW)
            .setTitle("🐞 Bug & Feature — Konfirmasi Log Channel")
            .setDescription(`Channel dipilih: <#${channelId}>\n\nKlik **Simpan** untuk mengatur.`)
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`setup:bug:logs:save:${channelId}`).setLabel("💾 Simpan").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("setup:bug:logs").setLabel("↩ Pilih Ulang").setStyle(ButtonStyle.Secondary),
          ),
          _backRow("🔙 Kembali ke Bug & Feature"),
        ],
      });
      return;
    }

    const bugLogsSave = /^setup:bug:logs:save:(\d+)$/.exec(id);
    if (bugLogsSave) {
      if (await _denyNotOwner(interaction)) return;
      const channelId = bugLogsSave[1];
      bugReportDB.setConfig({ logsChannelId: channelId });
      const cfg = bugReportDB.getConfig();
      await interaction.update({
        embeds:     [_buildBugEmbed().setDescription(`✅ Log Bug & Feature diatur ke <#${channelId}>`)],
        components: _buildBugComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ── Dev Role ──────────────────────────────────────────────────────────

    if (id === "setup:bug:role") {
      if (await _denyNotOwner(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.BLUE)
            .setTitle("🐞 Bug & Feature — Pilih Developer Role")
            .setDescription("Pilih role yang akan di-mention otomatis saat ada laporan baru.")
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId("setup:bug:role:select")
              .setPlaceholder("👤 Pilih developer role..."),
          ),
          _backRow("🔙 Kembali ke Bug & Feature"),
        ],
      });
      return;
    }

    if (id === "setup:bug:role:select" && interaction.isRoleSelectMenu()) {
      if (await _denyNotOwner(interaction)) return;
      const roleId = interaction.values[0];
      bugReportDB.setConfig({ developerRoleId: roleId });
      const cfg = bugReportDB.getConfig();
      await interaction.update({
        embeds:     [_buildBugEmbed().setDescription(`✅ Developer role diatur ke <@&${roleId}>`)],
        components: _buildBugComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ── Delete Bug Setup ──────────────────────────────────────────────────

    if (id === "setup:bug:delete") {
      if (await _denyNotOwner(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.RED)
            .setTitle("⚠️ Konfirmasi Hapus Setup Bug & Feature")
            .setDescription(
              "Tindakan ini akan menghapus:\n" +
              "✔ Panel Bug Report & Feature Request\n✔ Seluruh konfigurasi Bug & Feature\n\n" +
              "⚠️ Apakah kamu yakin?"
            )
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("setup:bug:delete:confirm").setLabel("✅ Ya, Hapus").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("setup:bug:delete:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    }

    if (id === "setup:bug:delete:confirm") {
      if (await _denyNotOwner(interaction)) return;
      await interaction.deferUpdate();
      const cfg = bugReportDB.getConfig();
      if (cfg.panelChannelId && cfg.panelMessageId) {
        try {
          const ch  = await interaction.client.channels.fetch(cfg.panelChannelId).catch(() => null);
          const msg = ch ? await ch.messages.fetch(cfg.panelMessageId).catch(() => null) : null;
          if (msg) await msg.delete().catch(() => {});
        } catch { /* abaikan */ }
      }
      bugReportDB.resetConfig();
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.GREEN)
            .setTitle("✅ Setup Bug & Feature Dihapus")
            .setDescription("Seluruh konfigurasi Bug & Feature berhasil dihapus.\n\nJalankan `/setup` → 🐞 Bug & Feature untuk mengatur ulang.")
            .setFooter({ text: FOOTER }),
        ],
        components: [_backRow()],
      });
      return;
    }

    if (id === "setup:bug:delete:cancel") {
      if (await _denyNotOwner(interaction)) return;
      const cfg = bugReportDB.getConfig();
      await interaction.update({
        embeds:     [_buildBugEmbed()],
        components: _buildBugComponents(!!(cfg.panelChannelId || cfg.logsChannelId)),
      });
      return;
    }

    // ════════════════════════════════════════════════════════════════════════
    // PREMIUM STATS
    // ════════════════════════════════════════════════════════════════════════

    if (id === "setup:prem:main") {
      if (await _denyNotStaff(interaction)) return;
      const state = premDB.getPremStatsDashboardState();
      await interaction.update({
        embeds:     [_buildPremEmbed()],
        components: _buildPremComponents(!!(state?.channelId)),
      });
      return;
    }

    if (id === "setup:prem:channel") {
      if (await _denyNotStaff(interaction)) return;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.BLUE)
            .setTitle("👑 Premium Stats — Pilih Channel")
            .setDescription("Pilih channel tempat panel **Premium Statistics** dikirim dan diperbarui otomatis.")
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("setup:prem:channel:select")
              .setPlaceholder("📺 Pilih channel...")
              .addChannelTypes(ChannelType.GuildText),
          ),
          _backRow("🔙 Kembali ke Premium Stats"),
        ],
      });
      return;
    }

    if (id === "setup:prem:channel:select" && interaction.isChannelSelectMenu()) {
      if (await _denyNotStaff(interaction)) return;
      const channelId = interaction.values[0];
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR.YELLOW)
            .setTitle("👑 Premium Stats — Konfirmasi Channel")
            .setDescription(`Channel dipilih: <#${channelId}>\n\nKlik **Simpan** untuk membuat panel Premium Statistics.`)
            .setFooter({ text: FOOTER }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`setup:prem:channel:save:${channelId}`).setLabel("💾 Simpan & Buat Panel").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("setup:prem:channel").setLabel("↩ Pilih Ulang").setStyle(ButtonStyle.Secondary),
          ),
          _backRow("🔙 Kembali ke Premium Stats"),
        ],
      });
      return;
    }

    const premChannelSave = /^setup:prem:channel:save:(\d+)$/.exec(id);
    if (premChannelSave) {
      if (await _denyNotStaff(interaction)) return;
      await interaction.deferUpdate();
      const channelId = premChannelSave[1];

      // Hapus panel lama jika ada
      const oldState = premDB.getPremStatsDashboardState();
      if (oldState?.channelId && oldState?.messageId) {
        try {
          const ch  = await interaction.client.channels.fetch(oldState.channelId).catch(() => null);
          const msg = ch ? await ch.messages.fetch(oldState.messageId).catch(() => null) : null;
          if (msg) await msg.delete().catch(() => {});
        } catch { /* abaikan */ }
      }

      // Hapus panel "Premium Monitoring" lama jika ada di channel baru
      try {
        const ch = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (ch?.isTextBased()) {
          const messages = await ch.messages.fetch({ limit: 50 }).catch(() => null);
          if (messages) {
            for (const [, msg] of messages) {
              if (msg.author.id !== interaction.client.user.id) continue;
              if (msg.embeds.some(e => typeof e.title === "string" && e.title.includes("Premium Monitoring"))) {
                await msg.delete().catch(() => {});
              }
            }
          }
        }
      } catch { /* abaikan */ }

      premDB.setPremStatsDashboardState({ channelId, messageId: null });
      await updatePremStatsDashboard(interaction.client).catch(() => {});

      await interaction.editReply({
        embeds:     [_buildPremEmbed().setDescription(`✅ Panel Premium Statistics berhasil dibuat di <#${channelId}>`)],
        components: _buildPremComponents(true),
      });
      return;
    }

    if (id === "setup:prem:refresh") {
      if (await _denyNotStaff(interaction)) return;
      await interaction.deferUpdate();
      await updatePremStatsDashboard(interaction.client).catch(() => {});
      await interaction.editReply({
        embeds:     [_buildPremEmbed().setDescription("✅ Panel Premium Statistics diperbarui.")],
        components: _buildPremComponents(true),
      });
      return;
    }

    // Unknown — log and ignore
    logger.debug(`[AdminSetup] Unknown interaction: ${id}`);

  } catch (err) {
    logger.error(`[AdminSetup] Interaction error for "${id}": ${err.message}`);
    const content = "❌ Terjadi kesalahan pada panel konfigurasi.";
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    } else if (interaction.deferred) {
      await interaction.editReply({ content }).catch(() => {});
    }
  }
}

/**
 * Build the main admin setup embed + components.
 * Used by /setup command and setup:main interaction.
 */
export function buildMainSetupEmbed() {
  return _buildMainEmbed();
}

export function buildMainSetupComponents() {
  return _buildMainComponents();
}
