/**
 * ticketUtils.js — Small shared helpers for the Ticket system.
 */

/** "Ticket #007" style zero-padded numbering. */
export function padTicketNumber(n) {
  return String(n).padStart(3, "0");
}
