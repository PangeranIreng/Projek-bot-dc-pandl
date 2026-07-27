/**
 * Persistent state for the AI Core. This intentionally remains a small JSON
 * store, matching the rest of this standalone bot instead of introducing a
 * second database technology.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_LOG_CHANNEL_ID } from "../../config/channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "data", "ai-core-db.json");

const DEFAULT_DB = {
  config: {
    errorChannelId: ERROR_LOG_CHANNEL_ID || null,
    investigationChannelId: null,
    accessMode: "owner",
    allowedRoleIds: [],
    allowedUserIds: [],
    provider: "openai",
    model: "gpt-5.4-mini",
    timeoutMs: 30000,
    maxResponse: 1800,
    errorAnalysis: true,
    investigation: true,
    codeAnalysis: true,
    visionAnalysis: true,
  },
  projectKnowledge: {
    builtAt: null,
    summary: null,
    files: [],
  },
  errors: [],
  debugSessions: [],
  stats: { aiRequests: 0, failedRequests: 0 },
};

function clone(value) {
  return structuredClone(value);
}

export class AICoreDB {
  constructor() {
    this._ensureDir();
    this._data = this._load();
  }

  _ensureDir() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }

  _load() {
    if (!fs.existsSync(DB_PATH)) return clone(DEFAULT_DB);
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      return {
        ...clone(DEFAULT_DB),
        ...parsed,
        config: { ...clone(DEFAULT_DB.config), ...(parsed.config ?? {}) },
        projectKnowledge: {
          ...clone(DEFAULT_DB.projectKnowledge),
          ...(parsed.projectKnowledge ?? {}),
        },
        errors: Array.isArray(parsed.errors) ? parsed.errors : [],
        debugSessions: Array.isArray(parsed.debugSessions) ? parsed.debugSessions : [],
        stats: { ...clone(DEFAULT_DB.stats), ...(parsed.stats ?? {}) },
      };
    } catch {
      return clone(DEFAULT_DB);
    }
  }

  _save() {
    const tmp = `${DB_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DB_PATH);
  }

  get() {
    return clone(this._data);
  }

  getConfig() {
    return clone(this._data.config);
  }

  updateConfig(patch) {
    this._data.config = { ...this._data.config, ...patch };
    this._save();
    return this.getConfig();
  }

  getKnowledge() {
    return clone(this._data.projectKnowledge);
  }

  saveKnowledge(knowledge) {
    this._data.projectKnowledge = clone(knowledge);
    this._save();
  }

  findError(fingerprint) {
    return this._data.errors.find((item) => item.fingerprint === fingerprint) ?? null;
  }

  addError(record) {
    this._data.errors.unshift(clone(record));
    this._data.errors = this._data.errors.slice(0, 300);
    this._save();
  }

  updateError(errorId, patch) {
    const item = this._data.errors.find((entry) => entry.errorId === errorId);
    if (!item) return null;
    Object.assign(item, clone(patch));
    this._save();
    return clone(item);
  }

  getError(errorId) {
    const item = this._data.errors.find((entry) => entry.errorId === errorId);
    return item ? clone(item) : null;
  }

  listErrors(limit = 25) {
    return clone(this._data.errors.slice(0, limit));
  }

  createDebugSession(record) {
    this._data.debugSessions.unshift(clone(record));
    this._data.debugSessions = this._data.debugSessions.slice(0, 100);
    this._save();
  }

  incrementStat(key) {
    this._data.stats[key] = (this._data.stats[key] ?? 0) + 1;
    this._save();
  }
}

export const aiCoreDB = new AICoreDB();