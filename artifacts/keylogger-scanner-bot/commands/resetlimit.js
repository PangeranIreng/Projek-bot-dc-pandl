/**
 * commands/resetlimit.js — /resetlimit <target>
 *
 * Removes any custom limit override for a user or role (reverting to the
 * global default) and, for a user, restores today's BoomBox usage counter
 * back to full (0 used).
 */

import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { premDB, db } from "../boombox/db.js";
import { denyIfNotStaff } from "./permissions.js";
import { appendToPremiumLog } from "../boombox/premiumLog.js";
import { updateMonitoringDashboard } from "../boombox/monitoringDashboard.js";
import { updatePremStatsDashboard } from "../boombox/premStatsDashboard.js";

export const data = new SlashCommandBuilder()
  .setName("resetlimit")
  .setDescription("Reset limit BoomBox user atau role ke default & pulihkan penggunaan penuh")
  .addMentionableOption((opt) =>
    opt.setName("target").setDescription("User atau role yang direset limitnya").setRequired(true),
  );

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  const target = interaction.options.getMentionable("target");
  const isRole = "permissions" in target && "members" in target;

  let note;
  if (isRole) {
    premDB.deleteCustomLimitRole(target.id);
    note = `Limit khusus role ${target} dihapus. Setiap member sekarang mengikuti limit default.`;
  } else {
    premDB.deleteCustomLimitUser(target.id);
    db.resetUsage(target.id);
    note = `Limit khusus ${target} dihapus dan penggunaan hari ini dipulihkan ke penuh (0 terpakai).`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("🔄 Limit Direset")
    .setDescription(note)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });

  await appendToPremiumLog(interaction.client, {
    action:   "Limit Reset",
    target:   `${target}`,
    executor: `<@${interaction.user.id}>`,
    status:   "Success",
  });

  updateMonitoringDashboard(interaction.client).catch(() => {});
  updatePremStatsDashboard(interaction.client).catch(() => {});
}
