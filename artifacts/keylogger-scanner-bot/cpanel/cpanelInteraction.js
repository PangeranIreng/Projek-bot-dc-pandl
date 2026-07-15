/**
 * cpanelInteraction.js — Handles Discord interactions for the CPanel system.
 *
 * Custom ID prefixes:
 *   cp:role:<panelId>:<btnId>          — user clicks a role button
 *   cp:manage:addbtn:<panelId>         — staff adds a button (opens modal)
 *   cp:manage:editbtn:<panelId>:<btnId>— staff edits a button (opens modal)
 *   cp:manage:delbtn:<panelId>:<btnId> — staff deletes a button
 *   cp:manage:edit:<panelId>           — staff edits panel info (opens modal)
 *   cp:manage:delete:<panelId>         — staff confirms panel deletion
 *   cp:modal:create                    — modal submit: create panel
 *   cp:modal:edit:<panelId>            — modal submit: edit panel
 *   cp:modal:addbtn:<panelId>          — modal submit: add button
 *   cp:modal:editbtn:<panelId>:<btnId> — modal submit: edit button
 */

import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from "discord.js";

import { cpanelDB } from "./cpanelDB.js";
import {
  buildPanelEmbed,
  buildPanelComponents,
  buildManageEmbed,
  buildManageComponents,
  TEMPLATES,
} from "./cpanelEmbed.js";
import { isStaff } from "../commands/permissions.js";
import { logger } from "../utils/logger.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function parseColor(str) {
  if (!str) return 0x5865f2;
  const hex = str.trim().replace(/^#/, "");
  const n = parseInt(hex, 16);
  return isNaN(n) ? 0x5865f2 : n;
}

/** Re-send (or edit) the live panel message after a config change. */
async function refreshPanelMessage(client, panel) {
  if (!panel.channelId || !panel.messageId) return;
  try {
    const ch  = await client.channels.fetch(panel.channelId).catch(() => null);
    if (!ch?.isTextBased()) return;
    const msg = await ch.messages.fetch(panel.messageId).catch(() => null);
    if (!msg) return;
    await msg.edit({
      embeds:     [buildPanelEmbed(panel)],
      components: buildPanelComponents(panel),
    });
  } catch (e) {
    logger.warn(`[CPanel] Failed to refresh panel message ${panel.id}: ${e.message}`);
  }
}

// ── Role button (user-facing) ─────────────────────────────────────────────

async function handleRoleButton(interaction, panelId, btnId) {
  const panel = cpanelDB.getPanel(panelId);
  if (!panel) {
    await interaction.reply({ content: "❌ Panel tidak ditemukan.", ephemeral: true });
    return;
  }

  const btn = panel.buttons.find((b) => b.id === btnId);
  if (!btn) {
    await interaction.reply({ content: "❌ Button tidak ditemukan.", ephemeral: true });
    return;
  }

  if (!btn.roleId) {
    await interaction.reply({ content: "❌ Button ini belum dikonfigurasi dengan role.", ephemeral: true });
    return;
  }

  const member = interaction.member;
  if (!member) {
    await interaction.reply({ content: "❌ Tidak dapat mengidentifikasi member.", ephemeral: true });
    return;
  }

  const action = btn.action ?? "toggle";
  const hasRole = member.roles.cache.has(btn.roleId);

  try {
    if (action === "add" || (action === "toggle" && !hasRole)) {
      await member.roles.add(btn.roleId, "CPanel role button");
      await interaction.reply({
        content: `✅ Role <@&${btn.roleId}> berhasil diberikan!`,
        ephemeral: true,
      });
    } else if (action === "remove" || (action === "toggle" && hasRole)) {
      await member.roles.remove(btn.roleId, "CPanel role button");
      await interaction.reply({
        content: `✅ Role <@&${btn.roleId}> berhasil dilepas!`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({ content: "ℹ️ Tidak ada perubahan.", ephemeral: true });
    }
  } catch (e) {
    logger.warn(`[CPanel] Role toggle failed: ${e.message}`);
    await interaction.reply({
      content: `❌ Gagal mengubah role: ${e.message.slice(0, 200)}`,
      ephemeral: true,
    });
  }
}

// ── Management: Add Button modal ──────────────────────────────────────────

async function handleAddBtnModal(interaction, panelId) {
  const panel = cpanelDB.getPanel(panelId);
  if (!panel) {
    await interaction.reply({ content: "❌ Panel tidak ditemukan.", ephemeral: true });
    return;
  }
  if (panel.buttons.length >= 5) {
    await interaction.reply({ content: "❌ Maksimal 5 button per panel.", ephemeral: true });
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
        new TextInputBuilder().setCustomId("role_id").setLabel("Role ID (dari Discord)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(25),
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

// ── Management: Edit Button modal ─────────────────────────────────────────

async function handleEditBtnModal(interaction, panelId, btnId) {
  const panel = cpanelDB.getPanel(panelId);
  if (!panel) {
    await interaction.reply({ content: "❌ Panel tidak ditemukan.", ephemeral: true });
    return;
  }
  const btn = panel.buttons.find((b) => b.id === btnId);
  if (!btn) {
    await interaction.reply({ content: "❌ Button tidak ditemukan.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`cp:modal:editbtn:${panelId}:${btnId}`)
    .setTitle("Edit Button")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("label").setLabel("Label Button").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(btn.label ?? ""),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("emoji").setLabel("Emoji (opsional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50).setValue(btn.emoji ?? ""),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("role_id").setLabel("Role ID").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(25).setValue(btn.roleId ?? ""),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("style").setLabel("Style: Primary / Secondary / Success / Danger").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20).setValue(btn.style ?? "Primary"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("action").setLabel("Action: toggle / add / remove").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10).setValue(btn.action ?? "toggle"),
      ),
    );

  await interaction.showModal(modal);
}

// ── Management: Edit Panel modal ──────────────────────────────────────────

async function handleEditPanelModal(interaction, panelId) {
  const panel = cpanelDB.getPanel(panelId);
  if (!panel) {
    await interaction.reply({ content: "❌ Panel tidak ditemukan.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`cp:modal:edit:${panelId}`)
    .setTitle("Edit Panel")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("title").setLabel("Judul").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256).setValue(panel.title ?? ""),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("description").setLabel("Deskripsi").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(2000).setValue(panel.description ?? ""),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("color").setLabel("Warna Hex (misal: #5865f2)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10).setValue(panel.color ? "#" + panel.color.toString(16).padStart(6, "0") : "#5865f2"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("footer").setLabel("Footer Text").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(panel.footer ?? ""),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("thumbnail").setLabel("Thumbnail URL (opsional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setValue(panel.thumbnail ?? ""),
      ),
    );

  await interaction.showModal(modal);
}

// ── Modal submit handlers ─────────────────────────────────────────────────

async function handleModalCreate(interaction) {
  const fields = interaction.fields;
  const title       = fields.getTextInputValue("title");
  const description = fields.getTextInputValue("description") || "\u200B";
  const color       = parseColor(fields.getTextInputValue("color"));
  const footer      = fields.getTextInputValue("footer") || "Pangeran Assistant AI";
  const thumbnail   = fields.getTextInputValue("thumbnail") || null;
  const channelId   = interaction.channelId;
  const guildId     = interaction.guildId;

  await interaction.deferReply({ ephemeral: true });

  const panel = cpanelDB.createPanel({
    guildId, channelId, title, description, color, footer, thumbnail,
    createdBy: interaction.user.id,
  });

  // Send the panel to the channel
  try {
    const ch  = await interaction.client.channels.fetch(channelId).catch(() => null);
    const msg = await ch.send({
      embeds:     [buildPanelEmbed(panel)],
      components: buildPanelComponents(panel),
    });
    cpanelDB.updatePanel(panel.id, { messageId: msg.id });
    const updated = cpanelDB.getPanel(panel.id);
    await interaction.editReply({
      content: `✅ Panel berhasil dibuat!\n\n🆔 ID Panel: \`${panel.id}\`\nGunakan ID ini untuk mengelola panel.`,
      embeds:  [buildManageEmbed(updated)],
      components: buildManageComponents(updated),
    });
  } catch (e) {
    logger.error(`[CPanel] Failed to send panel: ${e.message}`);
    await interaction.editReply({ content: `❌ Panel dibuat di database tapi gagal dikirim ke channel: ${e.message}` });
  }
}

async function handleModalEdit(interaction, panelId) {
  const fields = interaction.fields;
  const title       = fields.getTextInputValue("title");
  const description = fields.getTextInputValue("description") || "\u200B";
  const color       = parseColor(fields.getTextInputValue("color"));
  const footer      = fields.getTextInputValue("footer") || "Pangeran Assistant AI";
  const thumbnail   = fields.getTextInputValue("thumbnail") || null;

  await interaction.deferReply({ ephemeral: true });

  const updated = cpanelDB.updatePanel(panelId, { title, description, color, footer, thumbnail });
  if (!updated) {
    await interaction.editReply({ content: "❌ Panel tidak ditemukan." });
    return;
  }

  await refreshPanelMessage(interaction.client, updated);
  await interaction.editReply({
    content:    "✅ Panel berhasil diperbarui!",
    embeds:     [buildManageEmbed(updated)],
    components: buildManageComponents(updated),
  });
}

async function handleModalAddBtn(interaction, panelId) {
  const fields  = interaction.fields;
  const label   = fields.getTextInputValue("label");
  const emoji   = fields.getTextInputValue("emoji") || null;
  const roleId  = fields.getTextInputValue("role_id") || null;
  const style   = fields.getTextInputValue("style") || "Primary";
  const action  = fields.getTextInputValue("action") || "toggle";

  await interaction.deferReply({ ephemeral: true });

  const updated = cpanelDB.addButton(panelId, { label, emoji, roleId, style, action });
  if (!updated) {
    await interaction.editReply({ content: "❌ Gagal menambah button (panel tidak ditemukan atau sudah 5 button)." });
    return;
  }

  await refreshPanelMessage(interaction.client, updated);
  await interaction.editReply({
    content:    "✅ Button berhasil ditambahkan!",
    embeds:     [buildManageEmbed(updated)],
    components: buildManageComponents(updated),
  });
}

async function handleModalEditBtn(interaction, panelId, btnId) {
  const fields  = interaction.fields;
  const label   = fields.getTextInputValue("label");
  const emoji   = fields.getTextInputValue("emoji") || null;
  const roleId  = fields.getTextInputValue("role_id") || null;
  const style   = fields.getTextInputValue("style") || "Primary";
  const action  = fields.getTextInputValue("action") || "toggle";

  await interaction.deferReply({ ephemeral: true });

  const updated = cpanelDB.updateButton(panelId, btnId, { label, emoji, roleId, style, action });
  if (!updated) {
    await interaction.editReply({ content: "❌ Gagal memperbarui button." });
    return;
  }

  await refreshPanelMessage(interaction.client, updated);
  await interaction.editReply({
    content:    "✅ Button berhasil diperbarui!",
    embeds:     [buildManageEmbed(updated)],
    components: buildManageComponents(updated),
  });
}

// ── Management button delete button ──────────────────────────────────────

async function handleDelBtn(interaction, panelId, btnId) {
  await interaction.deferReply({ ephemeral: true });

  const updated = cpanelDB.deleteButton(panelId, btnId);
  if (!updated) {
    await interaction.editReply({ content: "❌ Gagal menghapus button." });
    return;
  }

  await refreshPanelMessage(interaction.client, updated);
  await interaction.editReply({
    content:    "✅ Button berhasil dihapus!",
    embeds:     [buildManageEmbed(updated)],
    components: buildManageComponents(updated),
  });
}

// ── Management button: delete panel ──────────────────────────────────────

async function handleDeletePanel(interaction, panelId) {
  const panel = cpanelDB.getPanel(panelId);
  if (!panel) {
    await interaction.reply({ content: "❌ Panel tidak ditemukan.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Delete the Discord message
  try {
    const ch  = await interaction.client.channels.fetch(panel.channelId).catch(() => null);
    const msg = ch ? await ch.messages.fetch(panel.messageId).catch(() => null) : null;
    if (msg) await msg.delete();
  } catch { /* ignore — message may already be deleted */ }

  cpanelDB.deletePanel(panelId);
  await interaction.editReply({ content: `🗑️ Panel \`${panelId}\` berhasil dihapus.` });
}

// ── Main dispatcher ───────────────────────────────────────────────────────

export async function handleCpanelInteraction(interaction) {
  const id = interaction.customId ?? "";

  try {
    // ── Role button (user-facing) ──────────────────────────────────────
    const roleMatch = /^cp:role:([^:]+):([^:]+)$/.exec(id);
    if (roleMatch) {
      await handleRoleButton(interaction, roleMatch[1], roleMatch[2]);
      return;
    }

    // ── Staff-only management ─────────────────────────────────────────
    // All management actions require staff
    if (id.startsWith("cp:manage:") || id.startsWith("cp:modal:")) {
      if (!isStaff(interaction.member)) {
        const reply = interaction.isRepliable() ? interaction.reply.bind(interaction) : null;
        if (reply) await reply({ content: "❌ Hanya Owner/Developer yang dapat mengelola panel.", ephemeral: true }).catch(() => {});
        return;
      }
    }

    if (id.startsWith("cp:manage:addbtn:")) {
      await handleAddBtnModal(interaction, id.slice("cp:manage:addbtn:".length));
      return;
    }

    const editBtnMatch = /^cp:manage:editbtn:([^:]+):([^:]+)$/.exec(id);
    if (editBtnMatch) {
      await handleEditBtnModal(interaction, editBtnMatch[1], editBtnMatch[2]);
      return;
    }

    const delBtnMatch = /^cp:manage:delbtn:([^:]+):([^:]+)$/.exec(id);
    if (delBtnMatch) {
      await handleDelBtn(interaction, delBtnMatch[1], delBtnMatch[2]);
      return;
    }

    if (id.startsWith("cp:manage:edit:")) {
      await handleEditPanelModal(interaction, id.slice("cp:manage:edit:".length));
      return;
    }

    if (id.startsWith("cp:manage:delete:")) {
      await handleDeletePanel(interaction, id.slice("cp:manage:delete:".length));
      return;
    }

    // ── Modal submits ─────────────────────────────────────────────────
    if (id === "cp:modal:create") {
      await handleModalCreate(interaction);
      return;
    }

    if (id.startsWith("cp:modal:edit:")) {
      const panelId = id.slice("cp:modal:edit:".length);
      await handleModalEdit(interaction, panelId);
      return;
    }

    if (id.startsWith("cp:modal:addbtn:")) {
      await handleModalAddBtn(interaction, id.slice("cp:modal:addbtn:".length));
      return;
    }

    const editBtnModalMatch = /^cp:modal:editbtn:([^:]+):([^:]+)$/.exec(id);
    if (editBtnModalMatch) {
      await handleModalEditBtn(interaction, editBtnModalMatch[1], editBtnModalMatch[2]);
      return;
    }
  } catch (e) {
    logger.error(`[CPanel] Interaction error for "${id}": ${e.message}`);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Terjadi kesalahan pada CPanel.", ephemeral: true }).catch(() => {});
    }
  }
}
