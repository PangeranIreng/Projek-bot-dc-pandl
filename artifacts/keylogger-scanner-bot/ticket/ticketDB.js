/**
 * ticketDB.js — Persistent JSON-based storage for the Ticket system.
 * Mirrors the pattern used by boombox/boomboxDB.js: synchronous writes,
 * survives restarts, self-heals on missing/corrupt files.
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "data", "ticket-db.json");

const DEFAULT_DB = {
  // /cticket configuration — persists across restarts.
  config: {
    panelChannelId:     null,
    panelMessageId:     null, // last panel message sent, so /cticket can replace it instead of duplicating
    logsChannelId:      null,
    dashboardMessageId: null, // the single always-edited Ticket Logs dashboard message
    mentionRoleId:      null,
    // /setclaimticket — dedicated Staff Control channel for Claim/Close/Transcript/Delete buttons
    claimChannelId:     null,
    claimRoleId:        null,
  },
  // Running ticket number counter (never reused, even after closes).
  counter: 0,
  // Every ticket ever created.
  // { number, threadId, userId, handlerId, status: "open"|"claimed"|"closed",
  //   createdAt, closedAt, durationMs, firstReplySent }
  tickets: [],
};

export class TicketDB {
  constructor() {
    this._ensureDir();
    this._data = this._load();
  }

  _ensureDir() {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    if (!fs.existsSync(DB_PATH)) return structuredClone(DEFAULT_DB);
    try {
      const raw    = fs.readFileSync(DB_PATH, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ...structuredClone(DEFAULT_DB),
        ...parsed,
        config: { ...structuredClone(DEFAULT_DB.config), ...(parsed.config ?? {}) },
        tickets: Array.isArray(parsed.tickets) ? parsed.tickets : [],
      };
    } catch {
      return structuredClone(DEFAULT_DB);
    }
  }

  _save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this._data, null, 2), "utf8");
  }

  // ── Config ───────────────────────────────────────────────────────────────

  getConfig() {
    return { ...this._data.config };
  }

  /** @param {Partial<typeof DEFAULT_DB.config>} patch */
  setConfig(patch) {
    this._data.config = { ...this._data.config, ...patch };
    this._save();
  }

  // ── Ticket numbering ─────────────────────────────────────────────────────

  /** Atomically reserve and return the next ticket number (starts at 1). */
  nextTicketNumber() {
    this._data.counter = (this._data.counter ?? 0) + 1;
    this._save();
    return this._data.counter;
  }

  // ── Tickets ──────────────────────────────────────────────────────────────

  addTicket(ticket) {
    this._data.tickets.push(ticket);
    this._save();
  }

  getTicketByThread(threadId) {
    return this._data.tickets.find((t) => t.threadId === threadId) ?? null;
  }

  getTicketByNumber(number) {
    return this._data.tickets.find((t) => t.number === number) ?? null;
  }

  /** @param {string} threadId @param {Partial<object>} patch */
  updateTicket(threadId, patch) {
    const idx = this._data.tickets.findIndex((t) => t.threadId === threadId);
    if (idx === -1) return null;
    this._data.tickets[idx] = { ...this._data.tickets[idx], ...patch };
    this._save();
    return this._data.tickets[idx];
  }

  getAllTickets() {
    return [...this._data.tickets];
  }

  /** Wipe panel/dashboard/message IDs and mention role — used by /delcticket.
   * Deliberately leaves `tickets`/`counter` untouched (ticket history is not
   * "config" and the spec only asks to remove the panel/dashboard/config). */
  resetConfig() {
    this._data.config = structuredClone(DEFAULT_DB.config);
    this._save();
  }
}

export const ticketDB = new TicketDB();
