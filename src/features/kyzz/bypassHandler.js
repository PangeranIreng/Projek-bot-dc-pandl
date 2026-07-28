/**
 * bypassHandler.js — URL bypass via Kyzz API.
 *
 * Endpoints:
 *   /api/bypass/bypass   — Primary bypass
 *   /api/bypass/bypass2  — Fallback bypass
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
export async function handleBypassCommand(interaction) {
  const url = interaction.options.getString("url", true).trim();
  await interaction.deferReply();

  try {
    await enqueue("download", () => _runBypass(interaction, url), { priority: 3 });
  } catch (err) {
    logger.error(`[BypassCmd] Queue error: ${err.message}`);
    await interaction.editReply({ embeds: [_errEmbed("Gagal memproses bypass.")] }).catch(() => {});
  }
}

async function _runBypass(interaction, url) {
  logger.info(`[BypassCmd] ▶ ${url} | user=${interaction.user.id}`);

  let result = null;
  let usedEndpoint = null;

  // Try primary first, then fallback
  for (const ep of ["/api/bypass/bypass", "/api/bypass/bypass2"]) {
    try {
      const json = await kyzzGet(ep, { url }, { timeoutMs: TIMEOUT });
      const extracted = _extractResult(json);
      if (extracted) {
        result       = extracted;
        usedEndpoint = ep;
        break;
      }
    } catch (err) {
      logger.warn(`[BypassCmd] Endpoint ${ep} failed: ${err.message}`);
      if (ep === "/api/bypass/bypass2") {
        // Both failed
        await logError({ feature: "Bypass", reason: err.message, error: err }).catch(() => {});
        return interaction.editReply({
          embeds: [_errEmbed("Bypass gagal. URL mungkin tidak didukung atau sudah kadaluwarsa.")],
        });
      }
    }
  }

  if (!result) {
    return interaction.editReply({
      embeds: [_errEmbed("Bypass gagal — tidak ada URL hasil di dalam respons.")],
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ Bypass Berhasil")
    .addFields(
      { name: "🔗 URL Asli",  value: url.slice(0, 512),           inline: false },
      { name: "✅ URL Hasil", value: result.bypassedUrl.slice(0, 512), inline: false },
    )
    .setFooter({ text: `Powered by Kyzz API • ${usedEndpoint === "/api/bypass/bypass" ? "Primary" : "Fallback"}` })
    .setTimestamp();

  if (result.filename) embed.addFields({ name: "📄 Filename", value: result.filename.slice(0, 100), inline: true });
  if (result.filesize) embed.addFields({ name: "📦 Size",     value: String(result.filesize).slice(0, 50), inline: true });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("🔗 Open Bypassed URL")
      .setURL(result.bypassedUrl)
      .setStyle(ButtonStyle.Link)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

function _extractResult(json) {
  const ok =
    json.status === true || json.status === "ok" || json.status === "success" ||
    json.success === true;

  const r = json.result ?? json.data ?? json;

  const bypassedUrl =
    r.bypass        || r.bypassed_url || r.url     || r.result ||
    r.direct_url    || r.download     || r.link    ||
    json.bypass     || json.url       || json.link ||
    (typeof r === "string" && r.startsWith("http") ? r : null) ||
    null;

  if (!bypassedUrl || typeof bypassedUrl !== "string" || !bypassedUrl.startsWith("http")) {
    return null;
  }

  return {
    bypassedUrl,
    filename: r.filename || r.name || json.filename || null,
    filesize: r.filesize || r.size || json.filesize || null,
  };
}

function _errEmbed(msg) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ Bypass Gagal")
    .setDescription(msg.slice(0, 2048))
    .setTimestamp();
}
