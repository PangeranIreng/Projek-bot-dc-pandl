/**
 * ticketEmbed.js — Embed & component builders for the Ticket system.
 *
 * Panel embed:  posted once in panel_channel via /cticket, has the
 *               "Open Ticket" button.
 * Status embed: posted inside each ticket thread, edited in place as the
 *               ticket moves open → claimed → closed.
 * Control embed: in staff-only logs channel — Claim, Close, Transcript, Delete.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { padTicketNumber } from "./ticketUtils.js";

const COLOR_PANEL   = 0x5865f2; // Blurple
const COLOR_OPEN    = 0xf1c40f; // Yellow  — Menunggu Handle
const COLOR_CLAIMED = 0x57f287; // Green   — Di Handle
const COLOR_CLOSED  = 0xed4245; // Red     — Closed
const FOOTER_TEXT   = "Pangeran Assistant AI • Ticket System";

// ── Panel (posted once per /cticket panel_channel) ────────────────────────

export function buildPanelEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_PANEL)
    .setTitle("🎫 Open Ticket")
    .setDescription(
      [
        "Butuh bantuan?",
        "",
        "💢 Kesel kehabisan limit terus?",
        "🤖 Mau sewa Bot?",
        "🎤 Ready Jasa MC?",
        "",
        "Buka Ticket sesuai kebutuhan Anda.",
        "",
        "⚠️ Mohon gunakan Ticket dengan bijak.",
        "Dilarang membuat Ticket untuk bercanda, spam, atau tanpa tujuan yang jelas.",
        "Pelanggaran dapat dikenakan sanksi sesuai aturan yang berlaku.",
      ].join("\n"),
    )
    .setFooter({ text: FOOTER_TEXT });
}

export function buildPanelButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:open")
      .setLabel("Open Ticket")
      .setEmoji("🎫")
      .setStyle(ButtonStyle.Primary),
  );
}

// ── Ticket thread status embed (edited as the ticket progresses) ─────────

/**
 * @param {number} ticketNumber
 * @param {"open"|"claimed"|"closed"} status
 * @param {string|null} handlerId
 */
export function buildTicketStatusEmbed(ticketNumber, status, handlerId) {
  const statusLine =
    status === "open"    ? "🟡 Menunggu Handle..." :
    status === "claimed" ? "🟢 Di Handle" :
                            "🔴 Closed";

  const color =
    status === "open"    ? COLOR_OPEN :
    status === "claimed" ? COLOR_CLAIMED :
                            COLOR_CLOSED;

  const fields = [{ name: "Status", value: statusLine, inline: false }];
  if (status !== "open" && handlerId) {
    fields.push({ name: "Handler", value: `<@${handlerId}>`, inline: false });
  }

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎫 Ticket #${padTicketNumber(ticketNumber)}`)
    .setDescription("Selamat Datang.\n\nSilakan sampaikan kebutuhan atau keperluan Anda.")
    .addFields(fields)
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

// ── Staff-only control message (posted in the logs channel, NOT the thread) ─
//
// Discord has no concept of "show this button to some viewers of a message
// but not others" — everyone with access to a channel/thread sees the same
// components. Since a ticket thread is shared with the requester, the
// Claim/Close/Transcript/Delete buttons cannot live there without the
// requester also seeing them. Instead they live on a separate message in the
// (staff-only) Ticket Logs channel; the thread itself only ever shows plain
// status text.

/**
 * @param {number} ticketNumber
 * @param {"open"|"claimed"|"closed"} status
 * @param {string} userId      Ticket creator
 * @param {string|null} handlerId
 */
export function buildControlEmbed(ticketNumber, status, userId, handlerId) {
  const statusLine =
    status === "open"    ? "🟡 Menunggu Handle..." :
    status === "claimed" ? "🟢 Being Handled" :
                            "🔴 Closed";

  const color =
    status === "open"    ? COLOR_OPEN :
    status === "claimed" ? COLOR_CLAIMED :
                            COLOR_CLOSED;

  const fields = [
    { name: "Requester", value: `<@${userId}>`, inline: true },
    { name: "Status",    value: statusLine,     inline: true },
  ];
  if (handlerId) fields.push({ name: "Handled by", value: `<@${handlerId}>`, inline: true });

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎫 Ticket #${padTicketNumber(ticketNumber)} — Staff Controls`)
    .addFields(fields)
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

/**
 * Builds control buttons for the staff-only control message.
 * Only ever rendered in the staff-only logs channel.
 *
 * Buttons shown per status:
 *   open    → Claim, Transcript, Delete
 *   claimed → Close, Transcript, Delete
 *   closed  → Transcript (read-only access)
 *
 * @param {"open"|"claimed"|"closed"} status
 * @param {number} ticketNumber
 */
export function buildControlButtons(status, ticketNumber) {
  const transcriptBtn = new ButtonBuilder()
    .setCustomId(`ticket:transcript:${ticketNumber}`)
    .setLabel("Transcript")
    .setEmoji("📄")
    .setStyle(ButtonStyle.Secondary);

  const deleteBtn = new ButtonBuilder()
    .setCustomId(`ticket:delete:${ticketNumber}`)
    .setLabel("Delete")
    .setEmoji("🗑️")
    .setStyle(ButtonStyle.Danger);

  if (status === "open") {
    const claimBtn = new ButtonBuilder()
      .setCustomId(`ticket:claim:${ticketNumber}`)
      .setLabel("Claim Ticket")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success);
    return [
      new ActionRowBuilder().addComponents(claimBtn, transcriptBtn, deleteBtn),
    ];
  }

  if (status === "claimed") {
    const closeBtn = new ButtonBuilder()
      .setCustomId(`ticket:close:${ticketNumber}`)
      .setLabel("Close Ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger);
    return [
      new ActionRowBuilder().addComponents(closeBtn, transcriptBtn, deleteBtn),
    ];
  }

  // Closed — transcript only (no more actionable buttons)
  return [
    new ActionRowBuilder().addComponents(transcriptBtn),
  ];
}

/**
 * Builds the 4-button row for the Staff Control (claim) channel panel.
 * All 4 buttons are ALWAYS shown — regardless of ticket status.
 * These customIds reuse the existing ticket interaction handler routes.
 *
 * ✅ Claim Ticket  🔒 Lock Ticket  🗑 Delete Ticket  📄 Transcript
 *
 * @param {number} ticketNumber
 */
export function buildClaimPanelButtons(ticketNumber) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket:claim:${ticketNumber}`)
        .setLabel("Claim Ticket")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`ticket:close:${ticketNumber}`)
        .setLabel("Lock Ticket")
        .setEmoji("🔒")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`ticket:delete:${ticketNumber}`)
        .setLabel("Delete Ticket")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`ticket:transcript:${ticketNumber}`)
        .setLabel("Transcript")
        .setEmoji("📄")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}
