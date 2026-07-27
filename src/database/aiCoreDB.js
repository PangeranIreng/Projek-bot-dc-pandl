/**
 * Persistent state for the AI Core. This intentionally remains a small JSON
 * store, matching the rest of this standalone bot instead of introducing a
 * second database technology.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ERROR_LOG_CHANNEL_ID } from "../../config/channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH    = path.join(__dirname, "..", "..", "data", "ai-core-db.json");
// Stable file-based encryption key: written once on first use, never regenerated.
// Used only when neither AI_CORE_ENCRYPTION_KEY nor SESSION_SECRET is available.
const KEY_FILE_PATH = path.join(__dirname, "..", "..", "data", ".ai-core-keyfile");

const DEFAULT_DB = {
  config: {
    errorChannelId: ERROR_LOG_CHANNEL_ID || null,
    investigationChannelId: null,
    accessMode: "owner",
    allowedRoleIds: [],
    allowedUserIds: [],
    provider: "openai",
    model: "gpt-4o-mini",
    keyStatus: "no_key_stored",
    providerStatus: "not_configured",
    providerStatusReason: null,
    providerCheckedAt: null,
    timeoutMs: 30000,
    maxResponse: 1800,
    errorAnalysis: true,
    investigation: true,
    codeAnalysis: true,
    visionAnalysis: true,
  },
  providerCredential: null,
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

/**
 * Resolve the encryption secret with three-level priority:
 *   1. AI_CORE_ENCRYPTION_KEY env var (explicit, highest priority)
 *   2. SESSION_SECRET env var (common Replit / platform fallback)
 *   3. Stable file-based key in data/.ai-core-keyfile (generated ONCE on
 *      first use and never regenerated — survives bot restarts and works
 *      on Pterodactyl / VPS / any platform that does not inject env vars).
 *
 * Never generates a new random key in memory: that would make existing
 * encrypted credentials unreadable after a restart.
 */
function resolveEncryptionSecret() {
  const envSecret = (process.env.AI_CORE_ENCRYPTION_KEY || process.env.SESSION_SECRET || "").trim();
  if (envSecret) return envSecret;

  // File-based fallback — stable across restarts.
  try {
    if (fs.existsSync(KEY_FILE_PATH)) {
      const stored = fs.readFileSync(KEY_FILE_PATH, "utf8").trim();
      if (stored.length >= 32) return stored;
    }
    // First use: generate a cryptographically random key and persist it.
    const newKey = crypto.randomBytes(32).toString("hex"); // 64 hex chars
    fs.mkdirSync(path.dirname(KEY_FILE_PATH), { recursive: true });
    fs.writeFileSync(KEY_FILE_PATH, newKey, { mode: 0o600, flag: "wx" }); // wx = fail if exists
    return newKey;
  } catch (fileErr) {
    // "wx" flag throws EEXIST when two processes race — re-read in that case.
    if (fileErr.code === "EEXIST") {
      try {
        const stored = fs.readFileSync(KEY_FILE_PATH, "utf8").trim();
        if (stored.length >= 32) return stored;
      } catch (_) { /* fall through to hard error */ }
    }
    const err = new Error(
      `AI Core secure storage: cannot read or create key file (${fileErr.code || fileErr.message}). ` +
      "Set AI_CORE_ENCRYPTION_KEY or SESSION_SECRET, or ensure the data/ directory is writable."
    );
    err.code = "AI_STORAGE";
    throw err;
  }
}

/** Returns a human-readable label for the active encryption source (safe to log). */
export function encryptionSourceLabel() {
  if ((process.env.AI_CORE_ENCRYPTION_KEY || "").trim()) return "AI_CORE_ENCRYPTION_KEY";
  if ((process.env.SESSION_SECRET || "").trim()) return "SESSION_SECRET";
  return "keyfile";
}

function encryptionKey() {
  const secret = resolveEncryptionSecret(); // throws with code AI_STORAGE if unavailable
  return crypto.scryptSync(secret, "ai-core-provider-credential", 32);
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptSecret(record) {
  if (!record?.iv || !record?.tag || !record?.ciphertext) return null;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
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
        providerCredential: parsed.providerCredential ?? null,
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

  hasStoredApiKey() {
    return Boolean(this._data.providerCredential?.ciphertext);
  }

  getApiKey() {
    return decryptSecret(this._data.providerCredential);
  }

  saveApiKey(apiKey) {
    this._data.providerCredential = encryptSecret(apiKey);
    this._save();
  }

  removeApiKey() {
    this._data.providerCredential = null;
    this._save();
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