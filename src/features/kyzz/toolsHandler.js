/**
 * toolsHandler.js — Tools features via Kyzz API.
 *
 * Endpoints:
 *   /api/tools/compare-device — Compare smartphones
 *   /api/tools/upscale-vid    — Upscale video
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { kyzzGet }  from "../../services/kyzzClient.js";
import { enqueue }  from "../queue/workerManager.js";
import { logger }   from "../../utils/logger.js";
import { logError } from "../../utils/errorLogger.js";

const TIMEOUT = 20_000;

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
export async function handleToolsCommand(interaction) {
  const sub = interaction.options.getSubcommand(true);
  await interaction.deferReply();

  try {
    await enqueue("download", () => _dispatch(interaction, sub), { priority: 3 });
  } catch (err) {
    logger.error(`[ToolsCmd] Queue error: ${err.message}`);
    await interaction.editReply({ embeds: [_errEmbed("Gagal memproses tools command.")] }).catch(() => {});
  }
}

async function _dispatch(interaction, sub) {
  try {
    switch (sub) {
      case "compare": return await _compareDevice(interaction);
      case "upscale": return await _upscaleVid(interaction);
      default:
        await interaction.editReply({ content: "❌ Sub-command tidak dikenal." });
    }
  } catch (err) {
    logger.error(`[ToolsCmd:${sub}] ${err.message}`);
    await logError({ feature: `Tools:${sub}`, reason: err.message, error: err }).catch(() => {});
    await interaction.editReply({ embeds: [_errEmbed(`Gagal: ${err.message.slice(0, 200)}`)] }).catch(() => {});
  }
}

// ── Compare device ────────────────────────────────────────────────────────────

async function _compareDevice(interaction) {
  const device1 = interaction.options.getString("device1", true).trim();
  const device2 = interaction.options.getString("device2", true).trim();

  const json = await kyzzGet("/api/tools/compare-device", {
    device1,
    device2,
  }, { timeoutMs: TIMEOUT });

  const r = json.result ?? json.data ?? json;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`📱 Compare: ${device1} vs ${device2}`)
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  // Device 1
  const d1 = r.device1 || r[device1] || r.first || {};
  const d2 = r.device2 || r[device2] || r.second || {};

  const _fmt = (d) => {
    const specs = [];
    if (d.brand || d.name)     specs.push(`📱 **${(d.brand || "") + " " + (d.name || d.model || "")}**`.trim());
    if (d.display)             specs.push(`🖥️ Display: ${d.display}`);
    if (d.processor || d.cpu)  specs.push(`⚡ CPU: ${d.processor || d.cpu}`);
    if (d.ram)                 specs.push(`💾 RAM: ${d.ram}`);
    if (d.storage)             specs.push(`💽 Storage: ${d.storage}`);
    if (d.battery)             specs.push(`🔋 Battery: ${d.battery}`);
    if (d.camera || d.rear_camera) specs.push(`📷 Camera: ${d.camera || d.rear_camera}`);
    if (d.os)                  specs.push(`⚙️ OS: ${d.os}`);
    if (d.price)               specs.push(`💰 Price: ${d.price}`);
    return specs.join("\n").slice(0, 1024) || "Spek tidak tersedia";
  };

  if (Object.keys(d1).length || Object.keys(d2).length) {
    embed.addFields(
      { name: `📱 ${device1}`, value: _fmt(d1), inline: true },
      { name: `📱 ${device2}`, value: _fmt(d2), inline: true },
    );
  } else {
    // Flat response
    const text = r.comparison || r.result || r.text || JSON.stringify(r).slice(0, 1500);
    embed.setDescription(String(text).slice(0, 2048));
  }

  if (r.winner || r.recommendation) {
    embed.addFields({
      name:  "🏆 Rekomendasi",
      value: (r.winner || r.recommendation).slice(0, 500),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ── Upscale video ─────────────────────────────────────────────────────────────

async function _upscaleVid(interaction) {
  const url = interaction.options.getString("url", true).trim();

  const json = await kyzzGet("/api/tools/upscale-vid", { url }, { timeoutMs: TIMEOUT });

  const r = json.result ?? json.data ?? json;

  const resultUrl =
    r.url || r.download_url || r.output || r.video_url || r.link ||
    json.url || json.output || json.result || null;

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("✨ Upscale Video")
    .setFooter({ text: "Powered by Kyzz API" })
    .setTimestamp();

  if (resultUrl && typeof resultUrl === "string" && resultUrl.startsWith("http")) {
    embed.setColor(0x57f287);
    embed.addFields(
      { name: "🔗 Input URL",  value: url.slice(0, 512),       inline: false },
      { name: "✅ Result URL", value: resultUrl.slice(0, 512), inline: false },
    );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("⬇️ Download Upscaled Video")
        .setURL(resultUrl)
        .setStyle(ButtonStyle.Link)
    );

    return interaction.editReply({ embeds: [embed], components: [row] });
  }

  // No clear URL — show raw response
  const text = r.message || r.status || r.text || JSON.stringify(r).slice(0, 500);
  embed.setDescription(String(text).slice(0, 2048));
  await interaction.editReply({ embeds: [embed] });
}

function _errEmbed(msg) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ Tools Error")
    .setDescription(msg.slice(0, 2048))
    .setTimestamp();
}
