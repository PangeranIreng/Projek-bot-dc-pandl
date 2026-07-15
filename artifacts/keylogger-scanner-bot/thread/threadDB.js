/**
 * thread/threadDB.js — Persistent config for the Auto Thread system.
 *
 * Stores per-channel ON/OFF state. Survives restarts.
 * Schema: { channels: { "<channelId>": { enabled: bool, guildId: string } } }
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "data", "thread-db.json");

const DEFAULT_DB = {
  channels: {},
};

export class ThreadDB {
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
        channels: parsed.channels ?? {},
      };
    } catch {
      return structuredClone(DEFAULT_DB);
    }
  }

  _save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this._data, null, 2), "utf8");
  }

  /** Enable auto-thread for a channel. */
  enable(channelId, guildId) {
    this._data.channels[channelId] = { enabled: true, guildId };
    this._save();
  }

  /** Disable auto-thread for a channel. */
  disable(channelId) {
    if (this._data.channels[channelId]) {
      this._data.channels[channelId].enabled = false;
      this._save();
    }
  }

  /** True if auto-thread is currently ON for this channel. */
  isEnabled(channelId) {
    return this._data.channels[channelId]?.enabled === true;
  }

  /**
   * All channels with their status for a given guild.
   * @param {string} guildId
   * @returns {Array<{ channelId: string, enabled: boolean }>}
   */
  getAll(guildId) {
    return Object.entries(this._data.channels)
      .filter(([, v]) => !guildId || v.guildId === guildId)
      .map(([channelId, v]) => ({ channelId, enabled: v.enabled }));
  }
}

export const threadDB = new ThreadDB();
