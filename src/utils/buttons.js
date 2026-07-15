import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

/**
 * Build the action row of buttons attached under a scan result embed.
 * customId scheme: `sk:<action>:<scanId>` so the interactionCreate handler
 * can dispatch on the action and look up context by scanId.
 * @param {string} scanId
 * @param {{hasWebhook: boolean, hasIndicators: boolean}} opts
 */
export function buildScanButtons(scanId, opts = {}) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sk:preview:${scanId}`)
      .setLabel("Full Preview")
      .setEmoji("🔍")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sk:download:${scanId}`)
      .setLabel("Download Preview")
      .setEmoji("📥")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sk:webhook:${scanId}`)
      .setLabel("Copy Webhook")
      .setEmoji("🔗")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!opts.hasWebhook),
    new ButtonBuilder()
      .setCustomId(`sk:indicators:${scanId}`)
      .setLabel("Copy Indicators")
      .setEmoji("🚩")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!opts.hasIndicators),
    new ButtonBuilder()
      .setCustomId(`sk:rescan:${scanId}`)
      .setLabel("Scan Again")
      .setEmoji("🔁")
      .setStyle(ButtonStyle.Secondary),
  );
  return row;
}
