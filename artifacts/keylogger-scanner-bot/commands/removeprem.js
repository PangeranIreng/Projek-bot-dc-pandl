/**
 * commands/removeprem.js — /removeprem <target>
 *
 * Removes BoomBox Premium immediately for a user or role.
 *
 * For users: the Premium Discord role is ALWAYS revoked, even if the database
 * shows no active Premium record — the role may have been granted manually or
 * via a path the DB doesn't know about.
 */

import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { premDB } from "../boombox/db.js";
import { denyIfNotStaff } from "./permissions.js";
import { revokePremiumRole } from "../boombox/premiumRoleSync.js";
import { appendToPremiumLog } from "../boombox/premiumLog.js";
import { updateMonitoringDashboard } from "../boombox/monitoringDashboard.js";
import { updatePremStatsDashboard } from "../boombox/premStatsDashboard.js";
import { IDS } from "../config/ids.js";

export const data = new SlashCommandBuilder()
  .setName("removeprem")
  .setDescription("Hapus BoomBox Premium dari user atau role")
  .addMentionableOption((opt) =>
    opt.setName("target").setDescription("User atau role yang dicabut Premium-nya").setRequired(true),
  );

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  const target = interaction.options.getMentionable("target");
  const isRole = "permissions" in target && "members" in target;

  const hadRecord = isRole
    ? premDB.getPremiumRole(target.id)
    : premDB.getPremiumUser(target.id);

  if (isRole) {
    premDB.deletePremiumRole(target.id);
  } else {
    premDB.deletePremiumUser(target.id);
  }

  // ── Always revoke the Discord Premium role for users ─────────────────────
  // Even when hadRecord is null: the role may have been granted outside the DB,
  // or the record may have already expired and been cleaned up. Revoking a role
  // a user doesn't have is a no-op (premiumRoleSync guards this).
  let roleSyncNote = "";
  if (!isRole) {
    const ok = await revokePremiumRole(interaction.client, IDS.GUILD_ID, target.id);
    if (!ok) roleSyncNote = "\n⚠️ Gagal mencabut role Premium di Discord (izin bot?), tetapi akses BoomBox Premium sudah dicabut.";
  }

  const descLine = hadRecord
    ? `Premium untuk ${target} telah dicabut **segera**.`
    : `${target} tidak memiliki Premium aktif di database — role Discord tetap diperiksa dan dicabut.`;

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ Premium Dihapus")
    .setDescription(descLine + roleSyncNote)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });

  await appendToPremiumLog(interaction.client, {
    action:   "Premium Removed",
    target:   `${target}`,
    executor: `<@${interaction.user.id}>`,
    status:   hadRecord ? "Success" : "No-op (tidak ada Premium aktif di database)",
  });

  updateMonitoringDashboard(interaction.client).catch(() => {});
  updatePremStatsDashboard(interaction.client).catch(() => {});
}
