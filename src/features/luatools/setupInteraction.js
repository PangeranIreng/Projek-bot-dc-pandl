/**
 * src/features/luatools/setupInteraction.js — Router untuk interaksi ltsetup:.
 *
 * Prefix routing:
 *   ltsetup:back                         → Panel utama setup
 *   ltsetup:view                         → Lihat konfigurasi (sama dengan back)
 *   ltsetup:edit                         → Ubah konfigurasi (buka setup wizard)
 *   ltsetup:close                        → Tutup panel
 *   ltsetup:delete                       → Konfirmasi hapus
 *   ltsetup:delete:confirm               → Hapus setup
 *   ltsetup:delete:cancel                → Batal hapus
 *   ltsetup:channel                      → Sub-panel pilih tool channel
 *   ltsetup:channel:<tool>               → ChannelSelectMenu untuk tool
 *   ltsetup:channel:select:<tool>        → Hasil ChannelSelectMenu
 *   ltsetup:logs                         → Sub-panel pilih log channel
 *   ltsetup:logs:<tool>                  → ChannelSelectMenu untuk log tool
 *   ltsetup:logs:select:<tool>           → Hasil ChannelSelectMenu
 */

import { logger } from "../../utils/logger.js";
import { ltDB }   from "../../database/db.js";

import {
  buildLuaToolsConfiguredPanel,
  buildLuaToolsSetupPanel,
  buildDeleteConfirmPanel,
  buildClosedEmbed,
} from "./setup/panel.js";
import {
  buildChannelToolPanel,
  buildChannelSelectPanel,
  handleChannelSelected,
} from "./setup/channelSetup.js";
import {
  buildLogToolPanel,
  buildLogChannelSelectPanel,
  handleLogChannelSelected,
} from "./setup/logChannelSetup.js";

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

const TOOLS = ["obfuscator", "beautify", "deobfuscator"];
const FOOTER = "Lua Tools V1 • Setup Panel";

/**
 * Handle all interactions whose customId starts with "ltsetup:".
 * @param {import("discord.js").Interaction} interaction
 */
export async function handleLuaToolsSetupInteraction(interaction) {
  const id = interaction.customId ?? "";

  try {

    // ── Kembali ke panel utama ────────────────────────────────────────────
    if (id === "ltsetup:back" || id === "ltsetup:view") {
      const panel = ltDB.isAnyConfigured()
        ? buildLuaToolsConfiguredPanel()
        : buildLuaToolsSetupPanel();
      await interaction.update({ embeds: [panel.embed], components: panel.components });
      return;
    }

    // ── Ubah konfigurasi (buka wizard dari panel configured) ──────────────
    if (id === "ltsetup:edit") {
      const panel = buildLuaToolsSetupPanel();
      await interaction.update({ embeds: [panel.embed], components: panel.components });
      return;
    }

    // ── Tutup panel ───────────────────────────────────────────────────────
    if (id === "ltsetup:close") {
      await interaction.update({ embeds: [buildClosedEmbed()], components: [] });
      return;
    }

    // ── Hapus setup: konfirmasi ───────────────────────────────────────────
    if (id === "ltsetup:delete") {
      const { embed, components } = buildDeleteConfirmPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ── Hapus setup: Ya, Hapus ────────────────────────────────────────────
    if (id === "ltsetup:delete:confirm") {
      ltDB.reset();
      logger.info("[LuaTools] Setup dihapus oleh admin.");

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ Setup Berhasil Dihapus")
        .setDescription(
          "━━━━━━━━━━━━━━━━━━\n\n" +
          "Seluruh konfigurasi Lua Tools telah direset.\n\n" +
          "Bot tidak akan memproses file .lua sampai di-setup ulang.\n\n" +
          "━━━━━━━━━━━━━━━━━━"
        )
        .setFooter({ text: FOOTER })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ltsetup:edit")
          .setLabel("Setup Ulang")
          .setEmoji("✏️")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("ltsetup:close")
          .setLabel("Tutup")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.update({ embeds: [embed], components: [row] });
      return;
    }

    // ── Hapus setup: Batal ────────────────────────────────────────────────
    if (id === "ltsetup:delete:cancel") {
      const panel = buildLuaToolsConfiguredPanel();
      await interaction.update({ embeds: [panel.embed], components: panel.components });
      return;
    }

    // ── Setup Channel ─────────────────────────────────────────────────────
    if (id === "ltsetup:channel") {
      const { embed, components } = buildChannelToolPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // Pilih tool → tampilkan ChannelSelectMenu
    const chanToolMatch = /^ltsetup:channel:(obfuscator|beautify|deobfuscator)$/.exec(id);
    if (chanToolMatch && !id.includes(":select:")) {
      const tool = chanToolMatch[1];
      const { embed, components } = buildChannelSelectPanel(tool);
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // ChannelSelectMenu result
    const chanSelMatch = /^ltsetup:channel:select:(obfuscator|beautify|deobfuscator)$/.exec(id);
    if (chanSelMatch && interaction.isChannelSelectMenu()) {
      const tool = chanSelMatch[1];
      await handleChannelSelected(interaction, tool);
      return;
    }

    // ── Setup Logs ────────────────────────────────────────────────────────
    if (id === "ltsetup:logs") {
      const { embed, components } = buildLogToolPanel();
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // Pilih log tool → tampilkan ChannelSelectMenu
    const logToolMatch = /^ltsetup:logs:(obfuscator|beautify|deobfuscator)$/.exec(id);
    if (logToolMatch && !id.includes(":select:")) {
      const tool = logToolMatch[1];
      const { embed, components } = buildLogChannelSelectPanel(tool);
      await interaction.update({ embeds: [embed], components });
      return;
    }

    // Log ChannelSelectMenu result
    const logSelMatch = /^ltsetup:logs:select:(obfuscator|beautify|deobfuscator)$/.exec(id);
    if (logSelMatch && interaction.isChannelSelectMenu()) {
      const tool = logSelMatch[1];
      await handleLogChannelSelected(interaction, tool);
      return;
    }

    logger.debug(`[LuaTools] Unknown ltsetup: interaction: ${id}`);

  } catch (err) {
    logger.error(`[LuaTools] Setup interaction error for "${id}": ${err.message}`);
    const content = "❌ Terjadi kesalahan pada panel Setup Lua Tools.";
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    } else if (interaction.deferred) {
      await interaction.editReply({ content }).catch(() => {});
    }
  }
}
