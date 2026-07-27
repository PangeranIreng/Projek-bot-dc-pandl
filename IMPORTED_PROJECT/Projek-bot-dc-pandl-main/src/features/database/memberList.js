/**
 * features/database/memberList.js — Logika Member List panel DATABASE.
 *
 * Menampilkan statistik anggota server:
 *   - Total Member
 *   - Premium (dari premiumDB + role)
 *   - CEO (pemilik role OWNER_ROLE_ID)
 *   - Blacklist (belum ada sistem — tampilkan 0)
 *   - Member Aktif Hari Ini (dari boombox usage)
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IDS } from "../../../config/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.join(__dirname, "..", "..", "..");

/**
 * Ambil statistik member dari guild dan database.
 *
 * @param {import("discord.js").Guild} guild
 * @param {import("../../database/premiumDB.js").PremiumDB} premDB
 * @returns {Promise<{ total: number, premium: number, ceo: number, blacklist: number, activeToday: number }>}
 */
export async function getMemberStats(guild, premDB) {
  // Fetch semua member agar cache lengkap
  let members;
  try {
    members = await guild.members.fetch({ time: 10_000 });
  } catch {
    members = guild.members.cache;
  }

  const total = guild.memberCount ?? members.size;

  // Hitung CEO (member yang punya role OWNER_ROLE_ID, bukan bot)
  let ceo = 0;
  for (const [, member] of members) {
    if (!member.user.bot && member.roles.cache.has(IDS.OWNER_ROLE_ID)) ceo++;
  }

  // Hitung Premium dari premiumDB (user aktif yang belum expired)
  const now = new Date();
  const premUserCount = premDB.getAllPremiumUsers().filter((u) => {
    if (!u.expiresAt) return true; // permanent
    return new Date(u.expiresAt) > now;
  }).length;

  // Tambahkan pemegang premium role dari Discord langsung
  let premFromRole = 0;
  for (const [, member] of members) {
    if (!member.user.bot && member.roles.cache.has(IDS.PREMIUM_ROLE_ID)) premFromRole++;
  }
  const premium = Math.max(premUserCount, premFromRole);

  // Blacklist — belum ada sistem blacklist
  const blacklist = 0;

  // Member aktif hari ini — dari boombox DB
  const activeToday = _getActiveTodayCount();

  return { total, premium, ceo, blacklist, activeToday };
}

/**
 * Hitung jumlah pengguna unik yang menggunakan BoomBox hari ini.
 * Membaca boombox-db.json secara langsung.
 * @returns {number}
 */
function _getActiveTodayCount() {
  try {
    const DB_PATH = path.join(ROOT_DIR, "data", "boombox-db.json");
    if (!fs.existsSync(DB_PATH)) return 0;

    const raw   = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

    // BoomBox DB: { usage: { [userId]: { date, count } } } atau serupa
    let count = 0;
    const usage = raw.usage ?? raw.dailyUsage ?? raw.users ?? {};
    for (const record of Object.values(usage)) {
      const d = record.date ?? record.lastUsed ?? record.lastRequest ?? "";
      if (typeof d === "string" && d.startsWith(today)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Buat konten teks export daftar member premium untuk dikirim sebagai file.
 * @param {import("discord.js").Guild} guild
 * @param {import("../../database/premiumDB.js").PremiumDB} premDB
 * @returns {Promise<string>}
 */
export async function exportMemberList(guild, premDB) {
  let members;
  try {
    members = await guild.members.fetch({ time: 10_000 });
  } catch {
    members = guild.members.cache;
  }

  const now  = new Date().toLocaleString("id-ID");
  const lines = [];

  lines.push("═══════════════════════════════════════════════");
  lines.push("   DAFTAR MEMBER — PANGERAN ASSISTANT AI");
  lines.push(`   Export : ${now}`);
  lines.push(`   Server : ${guild.name}`);
  lines.push("═══════════════════════════════════════════════\n");

  // ── Premium Users ──────────────────────────────────────────────────────
  const nowDate   = new Date();
  const premUsers = premDB.getAllPremiumUsers().filter((u) => {
    if (!u.expiresAt) return true;
    return new Date(u.expiresAt) > nowDate;
  });

  lines.push("── 👑 PREMIUM USERS ────────────────────────────");
  if (premUsers.length === 0) {
    lines.push("  (tidak ada)");
  } else {
    for (const u of premUsers) {
      const member = members.get(u.userId);
      const name   = member ? member.user.username : `ID: ${u.userId}`;
      const exp    = u.expiresAt
        ? `exp: ${new Date(u.expiresAt).toLocaleDateString("id-ID")}`
        : "permanent";
      lines.push(`  • ${name.padEnd(25)} (${exp})`);
    }
  }

  // ── CEO / Owner ────────────────────────────────────────────────────────
  lines.push("\n── 🔱 CEO / OWNER ──────────────────────────────");
  let ceoCount = 0;
  for (const [, member] of members) {
    if (!member.user.bot && member.roles.cache.has(IDS.OWNER_ROLE_ID)) {
      lines.push(`  • ${member.user.username}`);
      ceoCount++;
    }
  }
  if (ceoCount === 0) lines.push("  (tidak ada)");

  // ── Bot Accounts ───────────────────────────────────────────────────────
  const botCount = [...members.values()].filter((m) => m.user.bot).length;

  // ── Ringkasan ──────────────────────────────────────────────────────────
  lines.push("\n── 📊 RINGKASAN ────────────────────────────────");
  lines.push(`  Total Member  : ${guild.memberCount ?? members.size}`);
  lines.push(`  Premium       : ${premUsers.length}`);
  lines.push(`  CEO           : ${ceoCount}`);
  lines.push(`  Bot           : ${botCount}`);
  lines.push(`  Blacklist     : 0`);

  lines.push("\n═══════════════════════════════════════════════");
  lines.push("  Pangeran Assistant AI — Database Export");
  lines.push("═══════════════════════════════════════════════");

  return lines.join("\n");
}

/**
 * Cari member berdasarkan nama (username atau display name).
 * @param {import("discord.js").Guild} guild
 * @param {string} query
 * @returns {Promise<import("discord.js").GuildMember[]>}
 */
export async function searchMembers(guild, query) {
  try {
    const result = await guild.members.search({ query: query.trim(), limit: 10 });
    return [...result.values()];
  } catch {
    // Fallback: cari dari cache
    const q = query.trim().toLowerCase();
    return [...guild.members.cache.values()]
      .filter((m) =>
        m.user.username.toLowerCase().includes(q) ||
        (m.displayName ?? "").toLowerCase().includes(q),
      )
      .slice(0, 10);
  }
}
