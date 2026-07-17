/**
 * luaToolsDB.js — Persistent JSON-based storage for Lua Tools config.
 * Survives restarts, redeploy, and reimport. All writes are synchronous.
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "..", "data", "luatools-db.json");

const DEFAULT_DB = {
  // Channel ID per tool (null = belum dikonfigurasi)
  channels: {
    obfuscator:   null,
    beautify:     null,
    deobfuscator: null,
  },
  // Log channel ID per tool (null = belum dikonfigurasi)
  logChannels: {
    obfuscator:   null,
    beautify:     null,
    deobfuscator: null,
  },
};

export class LuaToolsDB {
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
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      return {
        channels: { ...DEFAULT_DB.channels, ...parsed.channels },
        logChannels: { ...DEFAULT_DB.logChannels, ...parsed.logChannels },
      };
    } catch {
      return structuredClone(DEFAULT_DB);
    }
  }

  _save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this._data, null, 2), "utf8");
  }

  // ── Channel ───────────────────────────────────────────────────────────────

  getChannels() {
    return { ...this._data.channels };
  }

  setChannel(tool, channelId) {
    this._data.channels[tool] = channelId ?? null;
    this._save();
  }

  // ── Log Channel ───────────────────────────────────────────────────────────

  getLogChannels() {
    return { ...this._data.logChannels };
  }

  setLogChannel(tool, channelId) {
    this._data.logChannels[tool] = channelId ?? null;
    this._save();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Returns true if at least one tool channel is configured. */
  isAnyConfigured() {
    const ch = this._data.channels;
    return !!(ch.obfuscator || ch.beautify || ch.deobfuscator);
  }

  /** Reset all config to defaults. */
  reset() {
    this._data = structuredClone(DEFAULT_DB);
    this._save();
  }
}
