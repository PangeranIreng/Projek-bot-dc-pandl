/**
 * commands/setlimit.js — /setlimit <target> <limit> [durasi]
 *
 * Sets a custom daily BoomBox request limit for a user or role.
 *
 * Duration rules (same as /addprem):
 *   "7d" / "12h" / "30m"  → temporary, expires automatically
 *   Bare number ("1", "5") → permanent
 *   Omitted entirely       → permanent
 *
 * Examples:
 *   /setlimit @User  30 7d    → 30/day for 7 days
 *   /setlimit @Role 100 30d   → 100/day for 30 days
 *   /setlimit @User  50 12h   → 50/day for 12 hours
 *   /setlimit @User 100 30m   → 100/day for 30 minutes
 *   /setlimit @VIP 9999 1     → Unlimited, Permanent (bare number = permanent)
 *   /setlimit @Free  15       → 15/day, Permanent (omitted = permanent)
 */

import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { premDB } from "../boombox/db.js";
import { parsePremiumDuration } from "../boombox/durationParser.js";
import { denyIfNotStaff } from "./permissions.js";
import { appendToPremiumLog } from "../boombox/premiumLog.js";
import { updateMonitoringDashboard } from "../boombox/monitoringDashboard.js";
import { updatePremStatsDashboard } from "../boombox/premStatsDashboard.js";

export const data = new SlashCommandBuilder()
  .setName("setlimit")
  .setDescription("Atur limit harian BoomBox untuk user atau role")
  .addMentionableOption((opt) =>
    opt.setName("target").setDescription("User atau role yang diatur limitnya").setRequired(true),
  )
  .addIntegerOption((opt) =>
    opt.setName("limit").setDescription("Jumlah permintaan BoomBox per hari").setRequired(true).setMinValue(0),
  )
  .addStringOption((opt) =>
    opt
      .setName("durasi")
      .setDescription('Opsional: "7d" / "12h" / "30m", angka saja, atau kosongkan untuk Permanent'),
  );

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  const target      = interaction.options.getMentionable("target");
  const limit       = interaction.options.getInteger("limit", true);
  const rawDuration = interaction.options.getString("durasi");

  let expiresAt     = null;
  let durationLabel = "Lifetime";
  let durationLine  = "👑 Permanent";

  if (rawDuration) {
    const parsed = parsePremiumDuration(rawDuration);
    if (!parsed) {
      await interaction.reply({
        content:
          '❌ Format durasi tidak valid. Gunakan `7d` (hari), `12h` (jam), `30m` (menit), atau angka saja untuk **Permanent**.',
        ephemeral: true,
      });
      return;
    }
    if (!parsed.permanent) {
      const now      = Date.now();
      expiresAt      = new Date(now + parsed.ms).toISOString();
      durationLabel  = parsed.label;
      durationLine   = `⏳ Temporary — ${parsed.label} (expires <t:${Math.floor((now + parsed.ms) / 1000)}:R>)`;
    }
    // parsed.permanent → keep defaults (expiresAt = null, "Lifetime" / "👑 Permanent")
  }

  const record = {
    limit,
    type:      expiresAt ? "temporary" : "permanent",
    expiresAt: expiresAt,
  };

  const isRole = "permissions" in target && "members" in target;
  if (isRole) {
    premDB.setCustomLimitRole(target.id, record);
  } else {
    premDB.setCustomLimitUser(target.id, record);
  }
  premDB.setLastCustomLimitTarget(`${target}`);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📊 Limit BoomBox Diatur")
    .addFields(
      { name: "🎯 Target",    value: `${target}`,  inline: true  },
      { name: "🔢 Limit/hari", value: `${limit}`,  inline: true  },
      { name: "⏱ Durasi",     value: durationLine, inline: false },
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });

  await appendToPremiumLog(interaction.client, {
    action:        "Limit Set",
    target:        `${target}`,
    limit:         limit,
    durationLabel: durationLabel,
    expiresAt:     expiresAt,
    executor:      `<@${interaction.user.id}>`,
    status:        "Success",
  });

  updateMonitoringDashboard(interaction.client).catch(() => {});
  updatePremStatsDashboard(interaction.client).catch(() => {});
}
