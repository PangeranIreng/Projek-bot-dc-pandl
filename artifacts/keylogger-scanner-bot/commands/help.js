/**
 * commands/help.js — /help slash command.
 *
 * Interactive help: shows a category selector. Clicking a category shows
 * all commands in that category with examples. Ephemeral so it does not
 * clutter the channel.
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Tampilkan semua perintah bot — pilih kategori untuk detail");

const SEP = "─────────────────────────";
const FOOTER_TEXT = "Pangeran Assistant AI • Ketuk kategori untuk melihat perintahnya";

// ── Category definitions ──────────────────────────────────────────────────

const CATEGORIES = {
  boombox: {
    emoji: "🎵",
    label: "BoomBox",
    description: "Konversi YouTube/TikTok ke MP3",
  },
  ticket: {
    emoji: "🎫",
    label: "Ticket",
    description: "Sistem Open Ticket",
  },
  premium: {
    emoji: "👑",
    label: "Premium & Limit",
    description: "Manajemen premium & limit harian",
  },
  scanner: {
    emoji: "🔍",
    label: "Scanner",
    description: "Keylogger & Malware Scanner",
  },
  cpanel: {
    emoji: "📋",
    label: "CPanel",
    description: "Buat & kelola panel interaktif",
  },
  thread: {
    emoji: "🧵",
    label: "Thread",
    description: "Auto Thread per channel",
  },
  admin: {
    emoji: "⚙️",
    label: "Admin",
    description: "Setup & konfigurasi sistem",
  },
  general: {
    emoji: "ℹ️",
    label: "General",
    description: "Perintah umum",
  },
};

/** Hand-written usage docs, keyed by command name. Falls back to the live
 * SlashCommandBuilder description for any command not listed here. */
const USAGE = {
  // 🎵 BoomBox
  // (BoomBox is triggered by sending a YouTube/TikTok link in the BoomBox channel — no slash command)

  // 🎫 Ticket
  cticket: {
    category: "ticket",
    emoji: "🎫",
    summary: "Konfigurasi sistem Open Ticket (panel, logs, mention role). Owner/Developer.",
    examples: ["`/cticket panel_channel:#tiket logs_channel:#log-tiket mention_role:@Staff`"],
  },
  delcticket: {
    category: "ticket",
    emoji: "🗑️",
    summary: "Hapus panel, dashboard, dan konfigurasi Ticket System. Owner only.",
    examples: ["`/delcticket`"],
  },
  setclaimticket: {
    category: "ticket",
    emoji: "🎫",
    summary: "Atur channel Staff Control — notifikasi & tombol Claim/Close/Transcript/Delete dikirim ke sini.",
    examples: ["`/setclaimticket channel:#staff-control role:@Owner`"],
  },

  // 🧵 Thread
  thread: {
    category: "thread",
    emoji: "🧵",
    summary: "Aktifkan/nonaktifkan Auto Thread di channel tertentu, atau lihat daftarnya.",
    examples: [
      "`/thread on channel:#gallery` → Aktifkan",
      "`/thread off channel:#gallery` → Nonaktifkan",
      "`/thread list` → Lihat semua channel",
    ],
  },

  // 🐞 Report (under admin)
  cbug: {
    category: "admin",
    emoji: "🐞",
    summary: "Konfigurasi Report Center — panel Bug Report & Feature Request. Owner only.",
    examples: ["`/cbug panel_channel:#lapor logs_channel:#log-lapor developer_role:@Dev`"],
  },
  delcbug: {
    category: "admin",
    emoji: "🗑️",
    summary: "Hapus panel dan konfigurasi Report Center. Owner only.",
    examples: ["`/delcbug`"],
  },

  // 👑 Premium
  addprem: {
    category: "premium",
    emoji: "👑",
    summary: "Berikan BoomBox Premium (akses tak terbatas) ke user atau role.",
    examples: [
      "`/addprem @user 7d` → Premium 7 hari",
      "`/addprem @user 12h` → Premium 12 jam",
      "`/addprem @user 30m` → Premium 30 menit",
      "`/addprem @user 7` → **Permanent** (angka saja = Permanent)",
    ],
  },
  removeprem: {
    category: "premium",
    emoji: "❌",
    summary: "Cabut BoomBox Premium dari user atau role — berlaku segera.",
    examples: ["`/removeprem @user`", "`/removeprem @Premium`"],
  },
  setlimit: {
    category: "premium",
    emoji: "📊",
    summary: "Atur limit permintaan BoomBox per hari untuk user atau role.",
    examples: [
      "`/setlimit @user 20` → Permanent, 20x/hari",
      "`/setlimit @user 20 7d` → Temporary, 20x/hari selama 7 hari",
      "`/setlimit @Free 15` → berlaku untuk semua pemegang role Free",
    ],
  },
  resetlimit: {
    category: "premium",
    emoji: "🔄",
    summary: "Hapus limit khusus (kembali ke default) & pulihkan penggunaan hari ini ke penuh.",
    examples: ["`/resetlimit @user`", "`/resetlimit @Free`"],
  },

  // 📋 CPanel
  cpanel: {
    category: "cpanel",
    emoji: "📋",
    summary: "Buat & kelola panel interaktif dengan role button.",
    examples: [
      "`/cpanel create` → Buat panel baru (modal akan muncul)",
      "`/cpanel list` → Lihat semua panel yang ada",
      "`/cpanel delete <id>` → Hapus panel",
      "`/cpanel preview <id>` → Preview panel",
      "`/cpanel template` → Lihat template tersedia",
      "`/cpanel addbtn <id>` → Tambah button ke panel",
    ],
  },

  // ℹ️ General
  help: {
    category: "general",
    emoji: "📖",
    summary: "Tampilkan pesan bantuan ini dengan kategori interaktif.",
    examples: ["`/help`"],
  },

  // ⚙️ Admin
  premstats: {
    category: "admin",
    emoji: "👑",
    summary: "Buat panel Premium Statistics di channel yang dipilih. Owner/Developer only.",
    examples: ["`/premstats channel:#premium-stats` → Buat panel di channel tersebut"],
  },
  cc: {
    category: "admin",
    emoji: "🗑️",
    summary: "Hapus pesan terakhir di channel ini sesuai jumlah yang ditentukan. Owner/Developer only.",
    examples: ["`/cc 50` → Hapus 50 pesan", "`/cc 99` → Hapus 99 pesan"],
  },
  deploy: {
    category: "admin",
    emoji: "🚀",
    summary: "Force deploy ulang semua slash command ke Discord. Owner/Developer only.",
    examples: ["`/deploy`"],
  },
  permissions: {
    category: "admin",
    emoji: "🛡️",
    summary: "Cek izin bot di channel / server saat ini.",
    examples: ["`/permissions`"],
  },
};

// ── Embed builders ────────────────────────────────────────────────────────

/** Overview embed shown on first /help invocation. */
function buildOverviewEmbed() {
  const catLines = Object.values(CATEGORIES).map(
    (c) => `${c.emoji} **${c.label}** — ${c.description}`,
  );

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📖 Bantuan — Pangeran Assistant AI")
    .setDescription(
      [
        "Pilih **kategori** dari menu di bawah untuk melihat daftar perintah dan contoh penggunaannya.",
        "",
        SEP,
        catLines.join("\n"),
        SEP,
        "",
        "**BoomBox** — kirim link YouTube/TikTok ke channel BoomBox, bot akan proses otomatis.",
        "**Scanner** — upload file ke channel scan, bot akan analisis otomatis.",
        "",
        "`!hesu` — status bot (perintah teks, bukan slash command)",
      ].join("\n"),
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

/** Detailed category embed. */
function buildCategoryEmbed(categoryKey, commands) {
  const cat   = CATEGORIES[categoryKey];
  if (!cat) return buildOverviewEmbed();

  // Filter commands in this category
  const relevant = [];
  for (const [name, usage] of Object.entries(USAGE)) {
    if (usage.category === categoryKey) relevant.push([name, usage]);
  }

  // Also include any command that has a live entry but no USAGE entry in this category
  for (const [name, mod] of commands.entries()) {
    if (!USAGE[name] && categoryKey === "general") {
      relevant.push([name, {
        emoji: "⚙️",
        summary: mod.data.description,
        examples: [`\`/${name}\``],
      }]);
    }
  }

  const fields = relevant.flatMap(([name, usage]) => [
    {
      name:  `${usage.emoji} /${name}`,
      value: [usage.summary, ...(usage.examples ?? [])].join("\n"),
      inline: false,
    },
  ]);

  if (fields.length === 0) {
    fields.push({
      name:  "Tidak ada perintah",
      value: "Kategori ini tidak memiliki slash command — fitur berjalan otomatis.",
      inline: false,
    });
  }

  // Category-specific footer descriptions
  const descriptions = {
    boombox: [
      "Kirim link **YouTube** atau **TikTok** ke channel BoomBox — bot akan proses otomatis tanpa slash command.",
      "",
      "**Platform didukung:**",
      "• YouTube: `youtube.com`, `youtu.be`, `music.youtube.com`",
      "• TikTok: `tiktok.com`, `vt.`, `vm.`, `m.tiktok.com`",
      "",
      "**Queue:** Max 5 proses bersamaan. Request ke-6+ masuk antrean FIFO — kamu dapat notifikasi DM.",
    ].join("\n"),
    scanner: [
      "Upload file ke channel Scanner — bot akan analisis otomatis.",
      "",
      "**Format didukung:** `.lua`, `.luac`, `.js`, `.py`, `.txt`, `.json`, `.zip`",
      "**Limited analysis:** `.rar`, `.7z`, `.exe`, `.dll` (entropy + string scan saja)",
      "",
      "Hasil: **Confidence Score** 0–100 + embed dengan 5 tombol interaktif.",
      "Gunakan `!hesu` untuk melihat status scanner.",
    ].join("\n"),
    ticket: [
      "Sistem ticket berbasis thread Discord.",
      "",
      "**Flow:** User klik `Open Ticket` → thread privat dibuat → staff claim/close via log channel.",
      "**Staff buttons:** Claim, Close, Transcript, Delete — hanya visible di log channel (bukan thread).",
    ].join("\n"),
    premium: [
      "Manajemen premium & limit harian BoomBox.",
      "",
      "Premium = akses unlimited. Free = limit harian (default 10x/hari).",
      "Custom limit bisa diatur per-user maupun per-role.",
    ].join("\n"),
    cpanel: [
      "Buat panel embed interaktif dengan role button.",
      "",
      "**Template:** Member, BoomBox, Premium, Custom",
      "**Buttons:** Max 5 per panel — klik = toggle/add/remove role otomatis",
      "Semua config tersimpan di database dan survive restart.",
    ].join("\n"),
    admin: [
      "Perintah konfigurasi sistem — Owner/Developer only.",
    ].join("\n"),
    general: [
      "Perintah umum yang dapat digunakan semua member.",
    ].join("\n"),
  };

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${cat.emoji} ${cat.label} — Detail Perintah`)
    .setDescription(descriptions[categoryKey] ?? "\u200B")
    .addFields(fields)
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

/** Build the category select menu. */
function buildCategorySelect(currentKey = null) {
  const options = Object.entries(CATEGORIES).map(([value, cat]) => ({
    label:       `${cat.emoji} ${cat.label}`,
    description: cat.description,
    value,
    default:     value === currentKey,
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("help:category")
      .setPlaceholder("📂 Pilih Kategori")
      .addOptions(options),
  );
}

// ── Command entry ─────────────────────────────────────────────────────────

export async function execute(interaction, ctx) {
  await interaction.reply({
    embeds:     [buildOverviewEmbed()],
    components: [buildCategorySelect(null)],
    ephemeral:  true,
  });
}

// ── Interaction handler (exported for use in index.js) ────────────────────

export async function handleHelpInteraction(interaction) {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== "help:category") return;

  const key = interaction.values[0];
  // ctx.commands must be passed — import is cyclic, so we store commands on
  // the client for the interaction handler to use.
  const commands = interaction.client._helpCommands ?? new Map();

  await interaction.update({
    embeds:     [buildCategoryEmbed(key, commands)],
    components: [buildCategorySelect(key)],
  });
}
