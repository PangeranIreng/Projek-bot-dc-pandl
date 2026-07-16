/**
 * databaseDB.js — Persistent JSON storage untuk sistem DATABASE.
 *
 * Schema (data/database-db.json):
 * {
 *   guildId:      string | null,
 *   createdBy:    string | null,
 *   createdAt:    string | null,
 *   categoryId:   string | null,   ← ID channel kategori Discord
 *   categoryName: string | null,   ← Nama kategori
 *   channels: {
 *     botSetting:  string | null,
 *     backup:      string | null,
 *     console:     string | null,
 *     memberList:  string | null,
 *   },
 *   messages: {
 *     botSetting:  string | null,
 *     backup:      string | null,
 *     memberList:  string | null,
 *   },
 *   github: { repo: string | null, branch: string, token: string | null },
 *   autoBackup: boolean,
 *   autoClean:  boolean,
 * }
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "..", "data", "database-db.json");

const DEFAULT_DB = {
  guildId:      null,
  createdBy:    null,
  createdAt:    null,
  categoryId:   null,
  categoryName: null,
  channels: {
    botSetting: null,
    backup:     null,
    console:    null,
    memberList: null,
  },
  messages: {
    botSetting: null,
    backup:     null,
    memberList: null,
  },
  github:     { repo: null, branch: "main", token: null },
  autoBackup: false,
  autoClean:  false,
};

export class DatabaseDB {
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
        ...structuredClone(DEFAULT_DB),
        ...parsed,
        channels: { ...structuredClone(DEFAULT_DB.channels), ...(parsed.channels ?? {}) },
        messages: { ...structuredClone(DEFAULT_DB.messages), ...(parsed.messages ?? {}) },
        github:   { ...structuredClone(DEFAULT_DB.github),   ...(parsed.github   ?? {}) },
      };
    } catch {
      return structuredClone(DEFAULT_DB);
    }
  }

  _save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this._data, null, 2), "utf8");
  }

  /** True jika sudah pernah setup (minimal satu channel tersimpan). */
  isSetup() {
    return !!(
      this._data.channels.botSetting ||
      this._data.channels.backup ||
      this._data.channels.console ||
      this._data.channels.memberList
    );
  }

  /** Kembalikan seluruh data setup (deep clone). */
  get() {
    return structuredClone(this._data);
  }

  /**
   * Simpan konfigurasi setelah setup selesai.
   * @param {{ botSetting: string, backup: string, console: string, memberList: string }} channels
   * @param {string} categoryId
   * @param {string} categoryName
   * @param {string} guildId
   * @param {string} userId
   */
  saveSetup(channels, categoryId, categoryName, guildId, userId) {
    this._data.channels     = { ...this._data.channels, ...channels };
    this._data.categoryId   = categoryId;
    this._data.categoryName = categoryName;
    this._data.guildId      = guildId;
    this._data.createdBy    = userId;
    this._data.createdAt    = new Date().toISOString();
    this._save();
  }

  /**
   * Simpan message ID panel agar bisa di-edit nanti.
   * @param {"botSetting"|"backup"|"memberList"} key
   * @param {string} messageId
   */
  setMessage(key, messageId) {
    this._data.messages[key] = messageId;
    this._save();
  }

  /** Hapus semua message ID panel. */
  clearMessages() {
    this._data.messages = { botSetting: null, backup: null, memberList: null };
    this._save();
  }

  /**
   * Update pengaturan GitHub / auto backup / auto clean.
   * @param {{ repo?: string|null, branch?: string, token?: string|null, autoBackup?: boolean, autoClean?: boolean }} patch
   */
  updateSettings(patch) {
    if ("repo"        in patch) this._data.github.repo   = patch.repo   ?? null;
    if ("branch"      in patch) this._data.github.branch = patch.branch  || "main";
    if ("token"       in patch) this._data.github.token  = patch.token  ?? null;
    if ("autoBackup"  in patch) this._data.autoBackup    = !!patch.autoBackup;
    if ("autoClean"   in patch) this._data.autoClean     = !!patch.autoClean;
    this._save();
  }

  /** Toggle autoBackup dan simpan. */
  toggleAutoBackup() {
    this._data.autoBackup = !this._data.autoBackup;
    this._save();
    return this._data.autoBackup;
  }

  /** Toggle autoClean dan simpan. */
  toggleAutoClean() {
    this._data.autoClean = !this._data.autoClean;
    this._save();
    return this._data.autoClean;
  }

  /** Reset HANYA konfigurasi setup (bukan data user/premium/backup). */
  reset() {
    this._data = structuredClone(DEFAULT_DB);
    this._save();
  }
}

export const databaseDB = new DatabaseDB();
