/**
 * setupInteraction.js — Router untuk semua interaksi bbsetup:.
 *
 * Prefix routing:
 *   bbsetup:back                                       → Kembali ke panel utama
 *   bbsetup:edit                                       → Buka wizard dari configured panel
 *   bbsetup:close                                      → Tutup panel
 *   bbsetup:delete                                     → Konfirmasi hapus
 *   bbsetup:delete:confirm                             → Reset semua config
 *   bbsetup:delete:cancel                              → Batal hapus
 *   bbsetup:channel                                    → Sub-panel pilih platform channel
 *   bbsetup:channel:<youtube|tiktok|spotify>           → Step 2: ChannelSelectMenu
 *   bbsetup:channel:select:<platform>                  → ChannelSelectMenu result (pending)
 *   bbsetup:channel:save:<platform>:<channelId>        → 💾 Simpan channel ke DB
 *   bbsetup:logs                                       → Sub-panel BoomBox Logs
 *   bbsetup:logs:setchannel                            → Ganti global log channel
 *   bbsetup:logs:channel:select                        → Global log ChannelSelectMenu result
 *   bbsetup:logs:platcfg:<platform>                    → Per-platform log ChannelSelectMenu
 *   bbsetup:logs:platcfg:select:<platform>             → Per-platform log select result (pending)
 *   bbsetup:logs:platcfg:save:<platform>:<channelId>   → 💾 Simpan platform log channel
 *   bbsetup:duration                                   → Sub-panel Batas Durasi
 *   bbsetup:dur:rolesel                                → Role select menu result
 *   bbsetup:dur:set:<roleId>:<minutes>                 → Preset durasi
 *   bbsetup:dur:custom:<roleId>                        → Buka modal custom durasi
 *   bbsetup:dur:reset:<roleId>                         → Reset ke default
 *   bbsetup:dur:modal:<roleId>                         → Modal submit
 *   bbsetup:maintenance                                → Sub-panel Maintenance
 *   bbsetup:maint:toggle:<platform|all>                → Toggle maintenance
 */

import { logger } from "../../utils/logger.js";
import { db }     from "../../database/db.js";

import {
  buildSetupBoomBoxPanel,
  buildConfiguredBoomBoxPanel,
  buildDeleteConfirmPanel,
  buildClosedEmbed,
  buildMonitorEmbed,
} from "./setup/panel.js";
import {
  buildChannelPlatformPanel,
  buildChannelSelectPanel,
  handleChannelSelected,
  handleChannelSave,
} from "./setup/channelSetup.js";
import {
  buildLogsPanel,
  buildLogChannelSelectPanel,
  handleLogChannelSelected,
  buildLogChannelSavedEmbed,
  buildPlatformLogSelectPanel,
  handlePlatformLogSelected,
  handlePlatformLogSave,
} from "./setup/logsSetup.js";
import {
  buildDurationPanel,
  buildDurationSetPanel,
  buildDurationModal,
  buildDurationSavedEmbed,
  buildDurationResetEmbed,
} from "./setup/durationSetup.js";
import { buildMaintenancePanel, handleMaintenanceToggle } from "./setup/maintenanceSetup.js";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { buildPublicLogPanel } from "./logs/viewer.js";

/**
 * Handle all interactions whose customId starts with "bbsetup:".
 * @param {import("discord.js").Interaction} interaction
 */
export async function handleSetupBoomBoxInteraction(interaction) {
  const id = interaction.customId ?? "";

  try {

    // ── Kembali ke panel utama ────────────────────────────────────────────
    if (id === "bbsetup:back") {
      const { embed, components } = db.isConfigured()
        ? buildConfiguredBoomBoxPanel()
        : buildSetupBoomBoxPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── Edit konfigurasi (dari configured panel) ──────────────────────────
    if (id === "bbsetup:edit") {
      const { embed, components } = buildSetupBoomBoxPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── Tutup panel ───────────────────────────────────────────────────────
    if (id === "bbsetup:close") {
      await interaction.update({ embeds: [buildClosedEmbed()], components: [] });
      return;
    }

    // ── Hapus konfigurasi: tampilkan konfirmasi ───────────────────────────
    if (id === "bbsetup:delete") {
      const { embed, components } = buildDeleteConfirmPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── Hapus konfigurasi: Ya, Hapus ─────────────────────────────────────
    if (id === "bbsetup:delete:confirm") {
      // Reset semua setting channel dan log channel (bukan data history)
      const settings = db.getSetting("channels") ? {} : null;
      db.setChannel("youtube", null);
      db.setChannel("tiktok",  null);
      db.setChannel("spotify", null);
      db.setLogChannel(null);
      db.setPlatformLogChannel("youtube", null);
      db.setPlatformLogChannel("tiktok",  null);
      db.setPlatformLogChannel("spotify", null);
      logger.info("[SetupBoomBox] Konfigurasi BoomBox dihapus oleh owner.");

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ Konfigurasi Berhasil Dihapus")
        .setDescription(
          "━━━━━━━━━━━━━━━━━━\n\n" +
          "Seluruh konfigurasi channel BoomBox telah direset.\n\n" +
          "Bot tidak akan memproses permintaan BoomBox sampai di-setup ulang.\n\n" +
          "━━━━━━━━━━━━━━━━━━"
        )
        .setFooter({ text: "BoomBox V2 • Setup Panel" })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("bbsetup:edit")
          .setLabel("Setup Ulang")
          .setEmoji("✏️")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("bbsetup:close")
          .setLabel("Tutup")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.update({ embeds: [embed], components: [row] });
      return;
    }

    // ── Hapus konfigurasi: Batal ──────────────────────────────────────────
    if (id === "bbsetup:delete:cancel") {
      const { embed, components } = buildConfiguredBoomBoxPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── Monitor ───────────────────────────────────────────────────────────
    if (id === "bbsetup:monitor") {
      const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("bbsetup:back")
          .setLabel("Kembali")
          .setEmoji("◀️")
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.update({ embeds: [buildMonitorEmbed()], components: [backRow] });
      return;
    }

    // ── Setup Channel ─────────────────────────────────────────────────────
    if (id === "bbsetup:channel") {
      const { embed, components } = buildChannelPlatformPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // Pilih platform → tampilkan ChannelSelectMenu
    const chanPlatMatch = /^bbsetup:channel:(youtube|tiktok|spotify)$/.exec(id);
    if (chanPlatMatch) {
      const platform = chanPlatMatch[1];
      const { embed, components } = buildChannelSelectPanel(platform);
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ChannelSelectMenu result → tampilkan pending + Simpan button
    const chanSelMatch = /^bbsetup:channel:select:(youtube|tiktok|spotify)$/.exec(id);
    if (chanSelMatch && interaction.isChannelSelectMenu()) {
      const platform = chanSelMatch[1];
      await handleChannelSelected(interaction, platform);
      return;
    }

    // 💾 Simpan channel → commit ke DB
    const chanSaveMatch = /^bbsetup:channel:save:(youtube|tiktok|spotify):(\d+)$/.exec(id);
    if (chanSaveMatch) {
      const [, platform, channelId] = chanSaveMatch;
      await handleChannelSave(interaction, platform, channelId);
      return;
    }

    // ── Setup BoomBox Logs ────────────────────────────────────────────────
    if (id === "bbsetup:logs") {
      const { embed, components } = buildLogsPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    if (id === "bbsetup:logs:setchannel") {
      const { embed, components } = buildLogChannelSelectPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    if (id === "bbsetup:logs:channel:select" && interaction.isChannelSelectMenu()) {
      await handleLogChannelSelected(interaction);
      return;
    }

    // ── Per-platform log channel setup ────────────────────────────────────
    const platCfgMatch = /^bbsetup:logs:platcfg:(youtube|tiktok|spotify)$/.exec(id);
    if (platCfgMatch && !id.includes(":select:") && !id.includes(":save:")) {
      const platform = platCfgMatch[1];
      const { embed, components } = buildPlatformLogSelectPanel(platform);
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // Per-platform log ChannelSelectMenu result → pending
    const platLogSelMatch = /^bbsetup:logs:platcfg:select:(youtube|tiktok|spotify)$/.exec(id);
    if (platLogSelMatch && interaction.isChannelSelectMenu()) {
      const platform = platLogSelMatch[1];
      await handlePlatformLogSelected(interaction, platform);
      return;
    }

    // 💾 Simpan per-platform log channel
    const platLogSaveMatch = /^bbsetup:logs:platcfg:save:(youtube|tiktok|spotify):(\d+)$/.exec(id);
    if (platLogSaveMatch) {
      const [, platform, channelId] = platLogSaveMatch;
      await handlePlatformLogSave(interaction, platform, channelId);
      return;
    }

    // ── Hapus Panel Lama ──────────────────────────────────────────────────
    if (id === "bbsetup:logs:deletepanel") {
      const logChannelId = db.getLogChannel() ?? null;
      const state        = db.getLogState();
      let   statusMsg    = "🗑️ Panel lama tidak ditemukan di database.";

      if (state.messageId && logChannelId) {
        try {
          const logCh = await interaction.client.channels.fetch(logChannelId).catch(() => null);
          if (logCh?.isTextBased()) {
            const oldMsg = await logCh.messages.fetch(state.messageId).catch(() => null);
            if (oldMsg) {
              await oldMsg.delete();
              statusMsg = "🗑️ Panel lama berhasil dihapus.";
            } else {
              statusMsg = "ℹ️ Pesan panel lama sudah tidak ada di channel.";
            }
          }
        } catch (delErr) {
          logger.warn(`[SetupBoomBox] Gagal hapus panel lama: ${delErr.message}`);
          statusMsg = `⚠️ Gagal hapus panel lama: ${delErr.message.slice(0, 80)}`;
        }
      }

      db.setLogState({ messageId: null });

      let panelCreated = false;
      if (logChannelId) {
        try {
          const logCh = await interaction.client.channels.fetch(logChannelId).catch(() => null);
          if (logCh?.isTextBased()) {
            const newMsg = await logCh.send(buildPublicLogPanel());
            db.setLogState({ messageId: newMsg.id });
            panelCreated = true;
          }
        } catch (createErr) {
          logger.warn(`[SetupBoomBox] Gagal buat panel baru: ${createErr.message}`);
        }
      }

      const confirmEmbed = new EmbedBuilder()
        .setColor(panelCreated ? 0x57f287 : 0xfaa61a)
        .setTitle(panelCreated ? "✅ Panel Diperbarui" : "🗑️ Panel Lama Dihapus")
        .setDescription(
          `${statusMsg}\n\n` +
          (panelCreated
            ? `✅ Panel BoomBox Logs V2 baru telah dibuat di <#${logChannelId}>.`
            : logChannelId
              ? "Panel baru akan dibuat otomatis setelah BoomBox berikutnya selesai."
              : "⚠️ Log channel belum dikonfigurasi. Gunakan **Ganti Log Channel** terlebih dahulu.")
        )
        .setFooter({ text: "BoomBox V2 • BoomBox Logs" })
        .setTimestamp();

      const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("bbsetup:logs")
          .setLabel("Kembali ke Setup Logs")
          .setEmoji("◀️")
          .setStyle(ButtonStyle.Primary),
      );

      await interaction.update({ embeds: [confirmEmbed], components: [backRow] });
      return;
    }

    // Platform maintenance toggle from Logs panel
    const logsToggleMatch = /^bbsetup:logs:toggle:(youtube|tiktok|spotify)$/.exec(id);
    if (logsToggleMatch) {
      const platform = logsToggleMatch[1];
      const newState = db.toggleMaintenance(platform);
      const label    = platform.charAt(0).toUpperCase() + platform.slice(1);
      logger.info(`[SetupBoomBox] Maintenance ${label}: ${newState ? "ON" : "OFF"} (toggled from Logs panel)`);
      const { embed, components } = buildLogsPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── Batas Durasi ──────────────────────────────────────────────────────
    if (id === "bbsetup:duration") {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "❌ Tidak dapat mengambil data guild.", ephemeral: true });
        return;
      }
      const { embed, components } = await buildDurationPanel(guild);
      await interaction.update({ embeds: [embed], components });
      return;
    }

    if (id === "bbsetup:dur:rolesel" && interaction.isStringSelectMenu()) {
      const roleId = interaction.values[0];
      const role   = interaction.guild?.roles.cache.get(roleId)
                  ?? await interaction.guild?.roles.fetch(roleId).catch(() => null);
      if (!role) {
        await interaction.reply({ content: "❌ Role tidak ditemukan.", ephemeral: true });
        return;
      }
      const { embed, components } = buildDurationSetPanel(role);
      await interaction.update({ embeds: [embed], components });
      return;
    }

    const durSetMatch = /^bbsetup:dur:set:(\d+):(\d+)$/.exec(id);
    if (durSetMatch) {
      const [, roleId, minutesStr] = durSetMatch;
      const minutes = Number(minutesStr);
      const role    = interaction.guild?.roles.cache.get(roleId)
                   ?? await interaction.guild?.roles.fetch(roleId).catch(() => null);
      db.setRoleLimit(roleId, minutes);

      const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("bbsetup:duration")
          .setLabel("Kembali ke Batas Durasi")
          .setEmoji("◀️")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("bbsetup:back")
          .setLabel("Menu Utama")
          .setEmoji("🏠")
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.update({
        embeds:     [buildDurationSavedEmbed(role?.name ?? roleId, minutes)],
        components: [backRow],
      });
      return;
    }

    const durCustomMatch = /^bbsetup:dur:custom:(\d+)$/.exec(id);
    if (durCustomMatch) {
      const roleId = durCustomMatch[1];
      await interaction.showModal(buildDurationModal(roleId));
      return;
    }

    const durResetMatch = /^bbsetup:dur:reset:(\d+)$/.exec(id);
    if (durResetMatch) {
      const roleId = durResetMatch[1];
      const role   = interaction.guild?.roles.cache.get(roleId)
                  ?? await interaction.guild?.roles.fetch(roleId).catch(() => null);
      db.deleteRoleLimit(roleId);

      const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("bbsetup:duration")
          .setLabel("Kembali ke Batas Durasi")
          .setEmoji("◀️")
          .setStyle(ButtonStyle.Primary),
      );
      await interaction.update({
        embeds:     [buildDurationResetEmbed(role?.name ?? roleId)],
        components: [backRow],
      });
      return;
    }

    const durModalMatch = /^bbsetup:dur:modal:(\d+)$/.exec(id);
    if (durModalMatch && interaction.isModalSubmit()) {
      const roleId      = durModalMatch[1];
      const rawMinutes  = interaction.fields.getTextInputValue("dur_minutes");
      const minutes     = parseInt(rawMinutes, 10);

      if (isNaN(minutes) || minutes < 1 || minutes > 1440) {
        await interaction.reply({
          content: "❌ Durasi tidak valid. Masukkan angka antara 1–1440 menit.",
          ephemeral: true,
        });
        return;
      }

      const role = interaction.guild?.roles.cache.get(roleId)
                ?? await interaction.guild?.roles.fetch(roleId).catch(() => null);
      db.setRoleLimit(roleId, minutes);

      const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("bbsetup:duration")
          .setLabel("Kembali ke Batas Durasi")
          .setEmoji("◀️")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("bbsetup:back")
          .setLabel("Menu Utama")
          .setEmoji("🏠")
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({
        embeds:     [buildDurationSavedEmbed(role?.name ?? roleId, minutes)],
        components: [backRow],
        ephemeral:  true,
      });
      return;
    }

    // ── Maintenance ───────────────────────────────────────────────────────
    if (id === "bbsetup:maintenance") {
      const { embed, components } = buildMaintenancePanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    const maintToggleMatch = /^bbsetup:maint:toggle:(youtube|tiktok|spotify|all)$/.exec(id);
    if (maintToggleMatch) {
      const platform = maintToggleMatch[1];
      await handleMaintenanceToggle(interaction, platform);
      return;
    }

    // Unknown — log and ignore
    logger.debug(`[SetupBoomBox] Unknown interaction: ${id}`);

  } catch (err) {
    logger.error(`[SetupBoomBox] Interaction error for "${id}": ${err.message}`);
    const content = "❌ Terjadi kesalahan pada panel Setup BoomBox.";
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    } else if (interaction.deferred) {
      await interaction.editReply({ content }).catch(() => {});
    }
  }
}
