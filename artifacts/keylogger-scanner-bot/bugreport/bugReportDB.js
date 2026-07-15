/**
 * bugReportDB.js — Persistent JSON-based config for the Bug Report &
 * Feature Request system. No thread/ticket state involved — this system
 * only ever needs to remember where its panel lives and where reports go.
 * Mirrors ticket/ticketDB.js's storage pattern (synchronous writes,
 * self-heals on missing/corrupt file).
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "data", "bugreport-db.json");

const DEFAULT_DB = {
  config: {
    panelChannelId:  null,
    panelMessageId:  null, // last panel message sent, so /cbug can edit it instead of spamming a new one
    logsChannelId:   null,
    developerRoleId: null,
  },
};

export class BugReportDB {
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
      };
    } catch {
      return structuredClone(DEFAULT_DB);
    }
  }

  _save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this._data, null, 2), "utf8");
  }

  getConfig() {
    return { ...this._data.config };
  }

  /** @param {Partial<typeof DEFAULT_DB.config>} patch */
  setConfig(patch) {
    this._data.config = { ...this._data.config, ...patch };
    this._save();
  }

  /** Wipe panel/logs/role config — used by /delcbug. */
  resetConfig() {
    this._data.config = structuredClone(DEFAULT_DB.config);
    this._save();
  }
}

export const bugReportDB = new BugReportDB();
