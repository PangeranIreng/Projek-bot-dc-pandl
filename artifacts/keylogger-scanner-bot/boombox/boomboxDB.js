/**
 * boomboxDB.js — Persistent JSON-based storage for BoomBox.
 * Survives restarts. All writes are synchronous for simplicity and safety.
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOMBOX_CONFIG } from "./boomboxConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "data", "boombox-db.json");

const DEFAULT_DB = {
  settings: {
    freeDailyLimit: BOOMBOX_CONFIG.DEFAULT_FREE_DAILY_LIMIT,
  },
  // { "YYYY-MM-DD": { userId: count } }
  dailyUsage: {},
  // Aggregated counters
  statistics: {
    total: 0,
    byPlatform: {},
  },
  // Last 500 entries
  history: [],
  // BoomBox Logs channel message tracking — the single embed being edited,
  // plus the (no-user-info) entries currently rendered in it, newest first.
  // Entries here are intentionally separate from `history` above: `history`
  // keeps full internal records (including userId) for limit/premium
  // bookkeeping, while `logState.entries` is the public, user-info-free view
  // shown in the archive channel.
  // { messageId: string|null, entries: Array<{title, platform, duration, boomboxUrl, timestamp}> }
  logState: {
    messageId: null,
    entries:   [],
  },
};

const MAX_HISTORY = 500;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export class BoomBoxDB {
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
      // Deep-merge defaults for any missing keys
      return {
        ...structuredClone(DEFAULT_DB),
        ...parsed,
        settings: { ...structuredClone(DEFAULT_DB.settings), ...(parsed.settings ?? {}) },
        logState: { ...structuredClone(DEFAULT_DB.logState), ...(parsed.logState ?? {}) },
      };
    } catch {
      return structuredClone(DEFAULT_DB);
    }
  }

  _save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this._data, null, 2), "utf8");
  }

  // ── Daily usage ──────────────────────────────────────────────────────────

  getUsage(userId) {
    const day = todayKey();
    return this._data.dailyUsage?.[day]?.[userId] ?? 0;
  }

  incrementUsage(userId) {
    const day = todayKey();
    if (!this._data.dailyUsage[day]) this._data.dailyUsage[day] = {};
    this._data.dailyUsage[day][userId] =
      (this._data.dailyUsage[day][userId] ?? 0) + 1;

    // Prune old days (keep last 7)
    const days = Object.keys(this._data.dailyUsage).sort();
    while (days.length > 7) {
      delete this._data.dailyUsage[days.shift()];
    }

    this._save();
  }

  /**
   * Restore a user's daily usage counter back to full (0 used today).
   * Used by /resetlimit.
   * @param {string} userId
   */
  resetUsage(userId) {
    const day = todayKey();
    if (this._data.dailyUsage?.[day]) {
      delete this._data.dailyUsage[day][userId];
      this._save();
    }
  }

  getFreeDailyLimit() {
    return this._data.settings?.freeDailyLimit ?? BOOMBOX_CONFIG.DEFAULT_FREE_DAILY_LIMIT;
  }

  setFreeDailyLimit(n) {
    if (!this._data.settings) this._data.settings = {};
    this._data.settings.freeDailyLimit = n;
    this._save();
  }

  // ── Statistics ───────────────────────────────────────────────────────────

  incrementStats(platform) {
    if (!this._data.statistics) this._data.statistics = { total: 0, byPlatform: {} };
    this._data.statistics.total = (this._data.statistics.total ?? 0) + 1;
    this._data.statistics.byPlatform[platform] =
      (this._data.statistics.byPlatform[platform] ?? 0) + 1;
    this._save();
  }

  getStatistics() {
    return this._data.statistics ?? { total: 0, byPlatform: {} };
  }

  // ── History ──────────────────────────────────────────────────────────────

  addHistory(entry) {
    if (!Array.isArray(this._data.history)) this._data.history = [];
    this._data.history.push(entry);
    if (this._data.history.length > MAX_HISTORY) {
      this._data.history = this._data.history.slice(-MAX_HISTORY);
    }
    this._save();
  }

  getHistory(limit = 20) {
    const h = this._data.history ?? [];
    return h.slice(-limit).reverse();
  }

  // ── Log message state ────────────────────────────────────────────────────

  /**
   * Get the active log message ID and the entries currently rendered in it.
   * @returns {{ messageId: string|null, entries: Array<object> }}
   */
  getLogState() {
    const state = this._data.logState ?? {};
    return {
      messageId: state.messageId ?? null,
      entries:   Array.isArray(state.entries) ? state.entries : [],
    };
  }

  /**
   * Update the active log message ID and/or its rendered entries.
   * @param {{ messageId?: string|null, entries?: Array<object> }} patch
   */
  setLogState(patch) {
    this._data.logState = { ...this._data.logState, ...patch };
    this._save();
  }

  /**
   * Reset the log state (start a fresh message).
   */
  resetLogState() {
    this._data.logState = { messageId: null, entries: [] };
    this._save();
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  getSetting(key) {
    return this._data.settings?.[key];
  }

  setSetting(key, value) {
    if (!this._data.settings) this._data.settings = {};
    this._data.settings[key] = value;
    this._save();
  }
}
