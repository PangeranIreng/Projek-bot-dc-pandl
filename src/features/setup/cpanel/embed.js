/**
 * cpanelEmbed.js — Embed & component builders for the CPanel system.
 *
 * buildPanelEmbed()      — The public panel embed (posted in any channel).
 * buildPanelComponents() — The role buttons for the panel.
 * buildManageEmbed()     — Staff-only management embed.
 * buildManageComponents()— Add/Edit/Delete button management row.
 * TEMPLATES              — Predefined templates for quick panel creation.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

// ── Button style map ──────────────────────────────────────────────────────

const STYLE_MAP = {
  Primary:   ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success:   ButtonStyle.Success,
  Danger:    ButtonStyle.Danger,
};

function resolveStyle(styleStr) {
  return STYLE_MAP[styleStr] ?? ButtonStyle.Primary;
}

// ── Panel embed (public — shown in the target channel) ────────────────────

/**
 * @param {object} panel  Panel record from CpanelDB
 */
export function buildPanelEmbed(panel) {
  const color = typeof panel.color === "number" ? panel.color : parseInt(String(panel.color).replace(/^#/, ""), 16) || 0x5865f2;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(panel.title ?? "Panel")
    .setDescription(panel.description ?? "\u200B")
    .setFooter({ text: panel.footer ?? "Pangeran Assistant AI" })
    .setTimestamp();

  if (panel.thumbnail) embed.setThumbnail(panel.thumbnail);
  if (panel.banner)    embed.setImage(panel.banner);

  return embed;
}

/**
 * Build the role button rows for a panel (max 5 buttons → 1 ActionRow).
 * Custom IDs: cp:role:<panelId>:<buttonId>
 *
 * @param {object} panel
 * @returns {import("discord.js").ActionRowBuilder[]}
 */
export function buildPanelComponents(panel) {
  if (!panel.buttons || panel.buttons.length === 0) return [];
  const buttons = panel.buttons.slice(0, 5).map((btn) => {
    const b = new ButtonBuilder()
      .setCustomId(`cp:role:${panel.id}:${btn.id}`)
      .setLabel(btn.label ?? "Role")
      .setStyle(resolveStyle(btn.style ?? "Primary"));
    if (btn.emoji) {
      try { b.setEmoji(btn.emoji); } catch { /* invalid emoji — skip */ }
    }
    return b;
  });
  return [new ActionRowBuilder().addComponents(...buttons)];
}

// ── Management embed (ephemeral, staff only) ─────────────────────────────

export function buildManageEmbed(panel) {
  const btnList = panel.buttons.length > 0
    ? panel.buttons.map((b, i) =>
        `${i + 1}. ${b.emoji ?? ""} **${b.label}** — Role: ${b.roleId ? `<@&${b.roleId}>` : "None"} | Style: ${b.style ?? "Primary"} | Action: ${b.action ?? "toggle"}`,
      ).join("\n")
    : "Belum ada button.";

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📋 CPanel Management — ${panel.title}`)
    .addFields(
      { name: "🆔 Panel ID",      value: panel.id,                                 inline: true },
      { name: "📌 Channel",        value: panel.channelId ? `<#${panel.channelId}>` : "—", inline: true },
      { name: "🎨 Template",       value: panel.template ?? "custom",               inline: true },
      { name: "🔘 Buttons",        value: `${panel.buttons.length} / 5\n${btnList}`, inline: false },
    )
    .setFooter({ text: "Pangeran Assistant AI • CPanel Management" })
    .setTimestamp();
}

/**
 * Management action buttons — shown ephemerally to staff.
 * @param {object} panel
 */
export function buildManageComponents(panel) {
  const addBtn = new ButtonBuilder()
    .setCustomId(`cp:manage:addbtn:${panel.id}`)
    .setLabel("Tambah Button")
    .setEmoji("➕")
    .setStyle(ButtonStyle.Success)
    .setDisabled(panel.buttons.length >= 5);

  const editBtn = new ButtonBuilder()
    .setCustomId(`cp:manage:edit:${panel.id}`)
    .setLabel("Edit Panel")
    .setEmoji("✏️")
    .setStyle(ButtonStyle.Primary);

  const deleteBtn = new ButtonBuilder()
    .setCustomId(`cp:manage:delete:${panel.id}`)
    .setLabel("Hapus Panel")
    .setEmoji("🗑️")
    .setStyle(ButtonStyle.Danger);

  const rows = [new ActionRowBuilder().addComponents(addBtn, editBtn, deleteBtn)];

  // One edit/delete button row per existing button (max 5 → 5 extra rows)
  // Only if buttons exist
  if (panel.buttons.length > 0) {
    const btnMgmtBtns = panel.buttons.slice(0, 5).flatMap((btn, i) => [
      new ButtonBuilder()
        .setCustomId(`cp:manage:editbtn:${panel.id}:${btn.id}`)
        .setLabel(`✏️ Button ${i + 1}`)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`cp:manage:delbtn:${panel.id}:${btn.id}`)
        .setLabel(`🗑️ Btn ${i + 1}`)
        .setStyle(ButtonStyle.Danger),
    ]);

    // Discord allows max 5 ActionRows, each with max 5 buttons
    // Group in pairs (2 buttons per button: edit + delete)
    for (let i = 0; i < btnMgmtBtns.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(...btnMgmtBtns.slice(i, i + 5)));
    }
  }

  return rows;
}

// ── Templates ──────────────────────────────────────────────────────────────

export const TEMPLATES = {
  member: {
    title:       "🏠 Welcome — Ambil Role Member",
    description: "Klik tombol di bawah untuk mendapatkan role Member dan mengakses server secara penuh.",
    color:       0x57f287,
    footer:      "Pangeran Assistant AI • Role System",
    buttons: [
      { label: "✅ Ambil Role Member", emoji: "✅", style: "Success",   action: "add"    },
    ],
  },
  boombox: {
    title:       "🎵 BoomBox Access",
    description: "Pilih akses BoomBox yang kamu inginkan.",
    color:       0x5865f2,
    footer:      "Pangeran Assistant AI • BoomBox",
    buttons: [
      { label: "🎵 BoomBox Free",    emoji: "🎵", style: "Primary",   action: "toggle" },
    ],
  },
  premium: {
    title:       "👑 Premium Membership",
    description: "Akses fitur premium BoomBox tanpa batas limit harian.\n\nHubungi Admin untuk informasi harga.",
    color:       0xfaa61a,
    footer:      "Pangeran Assistant AI • Premium",
    buttons: [],
  },
  custom: {
    title:       "Panel Baru",
    description: "Isi deskripsi panel di sini.",
    color:       0x5865f2,
    footer:      "Pangeran Assistant AI",
    buttons: [],
  },
};

/** Template list embed (shown on /cpanel template). */
export function buildTemplateListEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📋 CPanel — Template Tersedia")
    .addFields(
      Object.entries(TEMPLATES).map(([key, t]) => ({
        name:   `${t.title} (\`${key}\`)`,
        value:  t.description.slice(0, 80) + (t.description.length > 80 ? "..." : ""),
        inline: false,
      })),
    )
    .setDescription("Gunakan `/cpanel create template:<nama>` untuk memakai template.")
    .setFooter({ text: "Pangeran Assistant AI • CPanel Templates" })
    .setTimestamp();
}
