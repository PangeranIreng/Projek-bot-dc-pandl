/**
 * features/database/console.js — Console channel logger untuk sistem DATABASE.
 *
 * Console TIDAK menggunakan Edit Message — setiap aktivitas dikirim
 * sebagai pesan BARU ke channel console yang dikonfigurasi admin.
 *
 * Setiap log berisi: Tanggal, Jam, Status, Informasi.
 *
 * Tipe log:
 *   online       — 🟢 Bot Online
 *   backup       — 💾 Backup berhasil
 *   backup_upload— ☁ Backup berhasil diupload ke GitHub
 *   smartclean   — 🔍 Smart Clean selesai
 *   cleaned      — 🧹 Smart Clean berhasil dibersihkan
 *   warning      — ⚠ Peringatan
 *   db_save      — 🔄 Database disimpan
 *   restore      — ♻ Restore berhasil
 *   error        — ❌ Error
 *
 * Exports:
 *   initConsole(client)                         — simpan referensi client
 *   consoleLog(type, message, detail?)          — kirim pesan baru ke console channel
 */

import { EmbedBuilder } from "discord.js";
import { databaseDB }   from "../../database/databaseDB.js";
import { logger }       from "../../utils/logger.js";

let _client = null;

/** Inisialisasi logger dengan Discord client. Dipanggil sekali di ready.js. */
export function initConsole(client) {
  _client = client;
}

/**
 * Kirim log baru ke channel console yang dikonfigurasi.
 * Aman dipanggil sebelum initConsole() — akan di-skip saja.
 *
 * @param {string} type   Tipe log (lihat daftar di atas)
 * @param {string} message  Pesan singkat (muncul sebagai judul)
 * @param {string} [detail] Keterangan tambahan (opsional)
 */
export async function consoleLog(type, message, detail = null) {
  if (!_client) return;

  const setup = databaseDB.get();
  const channelId = setup.channels.console;
  if (!channelId) return;

  const now = new Date();
  const tanggal = now.toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
  const jam     = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const { emoji, color } = _getTypeStyle(type);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ${message}`)
    .addFields(
      { name: "📅 Tanggal", value: tanggal, inline: true },
      { name: "🕐 Jam",     value: jam,     inline: true },
      { name: "📌 Status",  value: type.toUpperCase(), inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Pangeran Assistant AI • Console" });

  if (detail) {
    embed.addFields({ name: "ℹ️ Informasi", value: String(detail).slice(0, 1024), inline: false });
  }

  try {
    const ch = await _client.channels.fetch(channelId).catch(() => null);
    if (ch?.isTextBased()) {
      await ch.send({ embeds: [embed] });
    }
  } catch (err) {
    logger.warn(`[Database/Console] Gagal mengirim log ke channel console: ${err.message}`);
  }
}

/** Kembalikan emoji dan warna embed berdasarkan tipe log. */
function _getTypeStyle(type) {
  switch (type) {
    case "online":        return { emoji: "🟢", color: 0x57f287 };
    case "backup":        return { emoji: "💾", color: 0x5865f2 };
    case "backup_upload": return { emoji: "☁",  color: 0x5865f2 };
    case "smartclean":    return { emoji: "🔍", color: 0xfee75c };
    case "cleaned":       return { emoji: "🧹", color: 0x57f287 };
    case "warning":       return { emoji: "⚠",  color: 0xfee75c };
    case "db_save":       return { emoji: "🔄", color: 0x5865f2 };
    case "restore":       return { emoji: "♻",  color: 0x57f287 };
    case "error":         return { emoji: "❌", color: 0xed4245 };
    default:              return { emoji: "📄", color: 0x95a5a6 };
  }
}
