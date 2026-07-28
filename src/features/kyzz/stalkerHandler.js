/**
 * stalkerHandler.js — Stalker features via Kyzz API.
 *
 * Endpoints:
 *   /api/stalker/jkt            — JKT48 stalker
 *   /api/stalker/tiktok-repost  — TikTok repost stalker
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { kyzzGet }  from "../../services/kyzzClient.js";
import { enqueue }  from "../queue/workerManager.js";
import { logger }   from "../../utils/logger.js";
import { logError } from "../../utils/errorLogger.js";

const TIMEOUT = 12_000;

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function handleStalkerCommand(interaction) {
  const sub = interaction.options.getSubcommand(true);
  await interaction.deferReply();

  try {
    await enqueue("search", () => _dispatch(interaction, sub), { priority: 3 });
  } catch (err) {
    logger.error(`[StalkerCmd] Queue error: ${err.message}`);
    await interaction.editReply({ embeds: [_errEmbed("Gagal memproses stalker command.")] }).catch(() => {});
  }
}

async function _dispatch(interaction, sub) {
  try {
    switch (sub) {
      case "jkt":     return await _stalkerJkt(interaction);
      case "tiktok":  return await _stalkerTiktok(interaction);
      default:
        await interaction.editReply({ content: "❌ Sub-command tidak dikenal." });
    }
  } catch (err) {
    logger.error(`[StalkerCmd:${sub}] ${err.message}`);
    await logError({ feature: `Stalker:${sub}`, reason: err.message, error: err }).catch(() => {});
    await interaction.editReply({ embeds: [_errEmbed(`Gagal: ${err.message.slice(0, 200)}`)] }).catch(() => {});
  }
}

async function _stalkerJkt(interaction) {
  const member = interaction.options.getString("member", true).trim();
  const json   = await kyzzGet("/api/stalker/jkt", { member }, { timeoutMs: TIMEOUT });

  const r = json.result ?? json.data ?? json;

  const embed = new EmbedBuilder()
    .setColor(0xff69b4)
    .setTitle(`🌸 JKT48 Stalker: ${member}`)
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  const name   = r.name || r.member_name || member;
  const team   = r.team || r.tim || "";
  const status = r.status || "";
  const social = r.social || r.instagram || r.twitter || r.tiktok || null;
  const photo  = r.photo || r.image || r.avatar || null;
  const bio    = r.bio || r.description || "";

  if (photo) embed.setThumbnail(photo);
  if (name)  embed.setDescription(`**${name}**\n${bio.slice(0, 500) || ""}`);

  if (team)   embed.addFields({ name: "Team",   value: team.slice(0, 100),   inline: true });
  if (status) embed.addFields({ name: "Status", value: status.slice(0, 100), inline: true });

  const rows = [];
  if (social && typeof social === "string" && social.startsWith("http")) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("🔗 Social Media").setURL(social).setStyle(ButtonStyle.Link)
    ));
  }

  // Handle schedule/upcoming events if present
  const schedule = r.schedule || r.jadwal || r.upcoming || null;
  if (schedule) {
    const sched = Array.isArray(schedule) ? schedule.slice(0, 3).map(s =>
      `• ${(s.title || s.event || s.name || "Event").slice(0, 80)}: ${s.date || s.tanggal || ""}`
    ).join("\n") : String(schedule).slice(0, 500);
    if (sched) embed.addFields({ name: "📅 Jadwal", value: sched.slice(0, 1024), inline: false });
  }

  await interaction.editReply({ embeds: [embed], components: rows });
}

async function _stalkerTiktok(interaction) {
  const username = interaction.options.getString("username", true).replace("@", "").trim();
  const json     = await kyzzGet("/api/stalker/tiktok-repost", { username }, { timeoutMs: TIMEOUT });

  const r = json.result ?? json.data ?? json;

  const embed = new EmbedBuilder()
    .setColor(0x69c9d0)
    .setTitle(`🎵 TikTok Stalker: @${username}`)
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  const nickname  = r.nickname || r.display_name || username;
  const followers = r.followers || r.follower_count || "";
  const following = r.following || r.following_count || "";
  const likes     = r.likes || r.like_count || "";
  const avatar    = r.avatar || r.profile_pic || null;
  const bio       = r.bio || r.signature || "";
  const verified  = r.verified ? "✅ Verified" : "";

  if (avatar) embed.setThumbnail(avatar);
  embed.setDescription([
    `**${nickname}** ${verified}`,
    bio.slice(0, 300),
  ].filter(Boolean).join("\n"));

  if (followers) embed.addFields({ name: "👥 Followers", value: String(followers), inline: true });
  if (following) embed.addFields({ name: "➡️ Following", value: String(following), inline: true });
  if (likes)     embed.addFields({ name: "❤️ Total Likes", value: String(likes),  inline: true });

  // Recent reposts
  const reposts = r.reposts || r.videos || r.recent || null;
  if (Array.isArray(reposts) && reposts.length) {
    const repostList = reposts.slice(0, 3).map((v, i) =>
      `${i + 1}. [${(v.title || v.desc || "Video").slice(0, 60)}](${v.url || v.link || "#"})`
    ).join("\n");
    embed.addFields({ name: "🔄 Recent Reposts", value: repostList.slice(0, 1024), inline: false });
  }

  const profileUrl = `https://www.tiktok.com/@${username}`;
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("🔗 Buka Profil TikTok").setURL(profileUrl).setStyle(ButtonStyle.Link)
    )
  ];

  await interaction.editReply({ embeds: [embed], components: rows });
}

function _errEmbed(msg) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ Stalker Error")
    .setDescription(msg.slice(0, 2048))
    .setTimestamp();
}
