/**
 * commands/addprem.js — /addprem <target> <durasi>
 *
 * Grants BoomBox Premium (unlimited usage) to a user or role, tracked in
 * premiumDB (data/premium-db.json) -- survives restarts. Does not touch
 * actual Discord roles; boomboxHandler checks premiumDB directly.
 *
 * Duration argument:
 *   "7d" / "12h" / "30m"  → temporary, expires automatically
 *   "7" (bare number)     → permanent (any bare number = permanent)
 */

import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { premDB } from "../boombox/db.js";
import { parsePremiumDuration } from "../boombox/durationParser.js";
import { denyIfNotStaff } from "./permissions.js";
import { grantPremiumRole } from "../boombox/premiumRoleSync.js";
import { appendToPremiumLog } from "../boombox/premiumLog.js";
import { updateMonitoringDashboard } from "../boombox/monitoringDashboard.js";
import { updatePremStatsDashboard } from "../boombox/premStatsDashboard.js";
import { IDS } from "../config/ids.js";

export const data = new SlashCommandBuilder()
  .setName("addprem")
  .setDescription("Berikan BoomBox Premium ke user atau role")
  .addMentionableOption((opt) =>
    opt.setName("target").setDescription("User atau role yang diberi Premium").setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("durasi")
      .setDescription('"7d" / "12h" / "30m", atau angka saja untuk Permanent')
      .setRequired(true),
  );

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  const target      = interaction.options.getMentionable("target");
  const rawDuration = interaction.options.getString("durasi", true);

  const parsed = parsePremiumDuration(rawDuration);
  if (!parsed) {
    await interaction.reply({
      content:
        '❌ Format durasi tidak valid. Gunakan `7d` (hari), `12h` (jam), `30m` (menit), atau angka saja (contoh: `7`) untuk **Permanent**.',
      ephemeral: true,
    });
    return;
  }

  const now      = Date.now();
  const expiresAt = parsed.permanent ? null : new Date(now + parsed.ms).toISOString();

  const record = {
    type:      parsed.permanent ? "permanent" : "temporary",
    expiresAt: expiresAt,
    grantedBy: interaction.user.id,
    grantedAt: new Date(now).toISOString(),
  };

  const isRole = "permissions" in target && "members" in target;
  if (isRole) {
    premDB.setPremiumRole(target.id, record);
  } else {
    premDB.setPremiumUser(target.id, record);
  }
  premDB.setLastPremiumTarget(`${target}`);

  // ── Grant the real Premium role automatically (users only) ───────────────
  let roleSyncNote = "";
  if (!isRole) {
    const ok = await grantPremiumRole(interaction.client, IDS.GUILD_ID, target.id);
    if (!ok) roleSyncNote = "\n⚠️ Gagal memberikan role Premium di Discord (izin bot?), tetapi akses BoomBox Premium tetap aktif.";
  }

  const durationLine = parsed.permanent
    ? "👑 Permanent"
    : `⏳ Temporary — ${parsed.label} (expires <t:${Math.floor((now + parsed.ms) / 1000)}:R>)`;

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("👑 Premium Ditambahkan")
    .addFields(
      { name: "🎯 Target",        value: `${target}`,                      inline: true  },
      { name: "⏱ Durasi",         value: durationLine,                     inline: true  },
      { name: "🛠 Diberikan oleh", value: `<@${interaction.user.id}>`,      inline: false },
    )
    .setDescription(roleSyncNote || null)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });

  await appendToPremiumLog(interaction.client, {
    action:        "Premium Added",
    target:        `${target}`,
    durationLabel: parsed.permanent ? "Lifetime" : parsed.label,
    expiresAt:     expiresAt,
    executor:      `<@${interaction.user.id}>`,
    status:        "Success",
  });

  updateMonitoringDashboard(interaction.client).catch(() => {});
  updatePremStatsDashboard(interaction.client).catch(() => {});
}
