/**
 * commands/cpanel.js — /cpanel slash command.
 *
 * Subcommands:
 *   create   — Create a new panel (opens modal for text fields)
 *   list     — List all panels in this server
 *   delete   — Delete a panel by ID
 *   preview  — Show panel preview ephemerally
 *   template — List available templates
 *   addbtn   — Add a button to an existing panel (opens modal)
 *   manage   — Open management UI for a panel
 *
 * All management is Owner/Developer only.
 */

import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
} from "discord.js";

import { denyIfNotStaff } from "./permissions.js";
import { cpanelDB } from "../cpanel/cpanelDB.js";
import {
  buildPanelEmbed,
  buildPanelComponents,
  buildManageEmbed,
  buildManageComponents,
  buildTemplateListEmbed,
  TEMPLATES,
} from "../cpanel/cpanelEmbed.js";
import { logger } from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("cpanel")
  .setDescription("Buat dan kelola panel interaktif dengan role button")

  // ── create ──────────────────────────────────────────────────────────────
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Buat panel baru di channel ini")
      .addStringOption((opt) =>
        opt
          .setName("template")
          .setDescription("Template panel bawaan (opsional)")
          .setRequired(false)
          .addChoices(
            { name: "Member",  value: "member"  },
            { name: "BoomBox", value: "boombox" },
            { name: "Premium", value: "premium" },
            { name: "Custom",  value: "custom"  },
          ),
      )
      .addStringOption((opt) =>
        opt.setName("color").setDescription("Warna embed hex, misal: #5865f2").setRequired(false),
      ),
  )

  // ── list ─────────────────────────────────────────────────────────────────
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Lihat semua panel di server ini"),
  )

  // ── delete ───────────────────────────────────────────────────────────────
  .addSubcommand((sub) =>
    sub
      .setName("delete")
      .setDescription("Hapus panel berdasarkan ID")
      .addStringOption((opt) =>
        opt.setName("panel_id").setDescription("ID panel (gunakan /cpanel list untuk melihatnya)").setRequired(true),
      ),
  )

  // ── preview ──────────────────────────────────────────────────────────────
  .addSubcommand((sub) =>
    sub
      .setName("preview")
      .setDescription("Preview panel secara ephemeral")
      .addStringOption((opt) =>
        opt.setName("panel_id").setDescription("ID panel").setRequired(true),
      ),
  )

  // ── template ─────────────────────────────────────────────────────────────
  .addSubcommand((sub) =>
    sub.setName("template").setDescription("Lihat template panel yang tersedia"),
  )

  // ── addbtn ───────────────────────────────────────────────────────────────
  .addSubcommand((sub) =>
    sub
      .setName("addbtn")
      .setDescription("Tambah button ke panel (membuka modal)")
      .addStringOption((opt) =>
        opt.setName("panel_id").setDescription("ID panel").setRequired(true),
      ),
  )

  // ── manage ───────────────────────────────────────────────────────────────
  .addSubcommand((sub) =>
    sub
      .setName("manage")
      .setDescription("Buka management UI untuk panel")
      .addStringOption((opt) =>
        opt.setName("panel_id").setDescription("ID panel").setRequired(true),
      ),
  );

// ── Handlers ──────────────────────────────────────────────────────────────

async function handleCreate(interaction) {
  const templateKey = interaction.options.getString("template") ?? "custom";
  const colorOption = interaction.options.getString("color") ?? null;
  const template    = TEMPLATES[templateKey] ?? TEMPLATES.custom;

  // Parse color from option (overrides template color)
  let color = template.color;
  if (colorOption) {
    const hex = colorOption.trim().replace(/^#/, "");
    const n   = parseInt(hex, 16);
    if (!isNaN(n)) color = n;
  }

  // Open a modal for title/description/footer/thumbnail/banner
  const modal = new ModalBuilder()
    .setCustomId("cp:modal:create")
    .setTitle("Buat Panel Baru")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Judul Panel")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(256)
          .setValue(template.title ?? "Panel Baru"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Deskripsi")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(2000)
          .setValue(template.description ?? ""),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("color")
          .setLabel("Warna Hex (misal: #5865f2)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setValue("#" + color.toString(16).padStart(6, "0")),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("footer")
          .setLabel("Footer Text")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setValue(template.footer ?? "Pangeran Assistant AI"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("thumbnail")
          .setLabel("Thumbnail URL (opsional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );

  await interaction.showModal(modal);
}

async function handleList(interaction) {
  const panels = cpanelDB.getAllPanels(interaction.guildId);

  if (panels.length === 0) {
    await interaction.reply({
      content: "📋 Belum ada panel yang dibuat di server ini.\nGunakan `/cpanel create` untuk membuat panel pertama.",
      ephemeral: true,
    });
    return;
  }

  const fields = panels.map((p) => ({
    name:  `${p.title ?? "Untitled"} — \`${p.id}\``,
    value: [
      `📌 Channel: ${p.channelId ? `<#${p.channelId}>` : "—"}`,
      `🔘 Buttons: ${p.buttons?.length ?? 0} / 5`,
      `🎨 Template: ${p.template ?? "custom"}`,
    ].join("\n"),
    inline: false,
  }));

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📋 Daftar CPanel")
    .setDescription(`Total: **${panels.length}** panel\n\nGunakan \`/cpanel manage <id>\` untuk mengelola panel.`)
    .addFields(fields.slice(0, 10)) // Discord embed field limit
    .setFooter({ text: "Pangeran Assistant AI • CPanel" })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleDelete(interaction) {
  const panelId = interaction.options.getString("panel_id", true).trim();
  const panel   = cpanelDB.getPanel(panelId);

  if (!panel) {
    await interaction.reply({ content: `❌ Panel dengan ID \`${panelId}\` tidak ditemukan.`, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Delete Discord message if found
  try {
    const ch  = await interaction.client.channels.fetch(panel.channelId).catch(() => null);
    const msg = ch ? await ch.messages.fetch(panel.messageId).catch(() => null) : null;
    if (msg) await msg.delete();
  } catch {
    logger.warn(`[CPanel] Could not delete panel message for ${panelId}`);
  }

  cpanelDB.deletePanel(panelId);
  await interaction.editReply({ content: `🗑️ Panel \`${panelId}\` (${panel.title}) berhasil dihapus.` });
}

async function handlePreview(interaction) {
  const panelId = interaction.options.getString("panel_id", true).trim();
  const panel   = cpanelDB.getPanel(panelId);

  if (!panel) {
    await interaction.reply({ content: `❌ Panel dengan ID \`${panelId}\` tidak ditemukan.`, ephemeral: true });
    return;
  }

  await interaction.reply({
    content:    `👁️ Preview panel \`${panelId}\`:`,
    embeds:     [buildPanelEmbed(panel)],
    components: buildPanelComponents(panel),
    ephemeral:  true,
  });
}

async function handleTemplate(interaction) {
  await interaction.reply({ embeds: [buildTemplateListEmbed()], ephemeral: true });
}

async function handleAddBtn(interaction) {
  const panelId = interaction.options.getString("panel_id", true).trim();
  const panel   = cpanelDB.getPanel(panelId);

  if (!panel) {
    await interaction.reply({ content: `❌ Panel dengan ID \`${panelId}\` tidak ditemukan.`, ephemeral: true });
    return;
  }
  if (panel.buttons.length >= 5) {
    await interaction.reply({ content: "❌ Panel sudah mencapai batas maksimal 5 button.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`cp:modal:addbtn:${panelId}`)
    .setTitle("Tambah Button ke Panel")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("label").setLabel("Label Button").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("emoji").setLabel("Emoji (opsional, misal: ✅)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("role_id").setLabel("Role ID").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(25),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("style").setLabel("Style: Primary / Secondary / Success / Danger").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20).setValue("Primary"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("action").setLabel("Action: toggle / add / remove").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10).setValue("toggle"),
      ),
    );

  await interaction.showModal(modal);
}

async function handleManage(interaction) {
  const panelId = interaction.options.getString("panel_id", true).trim();
  const panel   = cpanelDB.getPanel(panelId);

  if (!panel) {
    await interaction.reply({ content: `❌ Panel dengan ID \`${panelId}\` tidak ditemukan.`, ephemeral: true });
    return;
  }

  await interaction.reply({
    embeds:     [buildManageEmbed(panel)],
    components: buildManageComponents(panel),
    ephemeral:  true,
  });
}

// ── Main execute ───────────────────────────────────────────────────────────

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case "create":   return await handleCreate(interaction);
      case "list":     return await handleList(interaction);
      case "delete":   return await handleDelete(interaction);
      case "preview":  return await handlePreview(interaction);
      case "template": return await handleTemplate(interaction);
      case "addbtn":   return await handleAddBtn(interaction);
      case "manage":   return await handleManage(interaction);
      default:
        await interaction.reply({ content: "❌ Subcommand tidak dikenal.", ephemeral: true });
    }
  } catch (e) {
    logger.error(`[CPanel] Command error (/${sub}): ${e.message}`);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Terjadi kesalahan: ${e.message.slice(0, 200)}`, ephemeral: true }).catch(() => {});
    } else if (interaction.deferred) {
      await interaction.editReply({ content: `❌ Terjadi kesalahan: ${e.message.slice(0, 200)}` }).catch(() => {});
    }
  }
}
