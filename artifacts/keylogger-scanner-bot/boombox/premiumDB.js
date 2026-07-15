/**
 * premiumDB.js — Persistent JSON storage for the Premium & Limit Management system.
 *
 * Schema (data/premium-db.json):
 * {
 *   premiumUsers:     { [userId]:  { type, expiresAt, grantedBy, grantedAt } }
 *   premiumRoles:     { [roleId]:  { type, expiresAt, grantedBy, grantedAt } }
 *   customLimitUsers: { [userId]:  { limit, type, expiresAt } }
 *   customLimitRoles: { [roleId]:  { limit, type, expiresAt } }
 *   dashboard:        { messageId: string|null, entryIndex: number }
 * }
 *
 * type = "permanent" | "temporary"
 * expiresAt = null | ISO-8601 string
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "data", "premium-db.json");

const DEFAULT_DB = {
  premiumUsers:     {},
  premiumRoles:     {},
  customLimitUsers: {},
  customLimitRoles: {},
  dashboard:        { messageId: null, entryIndex: 0 },
  // Premium Statistics dashboard (new /premstats panel).
  // channelId: the channel chosen by /premstats
  // messageId: the single panel message, always edited in-place
  premStatsDashboard: { channelId: null, messageId: null },
  // Last target touched by /addprem and /setlimit respectively — shown on
  // the Premium Monitoring dashboard ("Last Premium User" / "Last Custom
  // Limit User"). Mention strings (e.g. "<@id>" or "<@&id>"), or null.
  lastPremiumTarget:     null,
  lastCustomLimitTarget: null,
};

export class PremiumDB {
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
        dashboard:          { ...structuredClone(DEFAULT_DB.dashboard),          ...(parsed.dashboard          ?? {}) },
        premStatsDashboard: { ...structuredClone(DEFAULT_DB.premStatsDashboard), ...(parsed.premStatsDashboard ?? {}) },
      };
    } catch {
      return structuredClone(DEFAULT_DB);
    }
  }

  _save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this._data, null, 2), "utf8");
  }

  // ── Premium Users ─────────────────────────────────────────────────────────

  getPremiumUser(userId) {
    return this._data.premiumUsers[userId] ?? null;
  }

  setPremiumUser(userId, record) {
    this._data.premiumUsers[userId] = record;
    this._save();
  }

  deletePremiumUser(userId) {
    delete this._data.premiumUsers[userId];
    this._save();
  }

  getAllPremiumUsers() {
    return Object.entries(this._data.premiumUsers).map(([userId, r]) => ({ userId, ...r }));
  }

  isUserPremium(userId) {
    const r = this._data.premiumUsers[userId];
    if (!r) return false;
    if (r.expiresAt && new Date(r.expiresAt) <= new Date()) return false;
    return true;
  }

  getExpiredPremiumUsers() {
    const now = new Date();
    return Object.entries(this._data.premiumUsers)
      .filter(([, r]) => r.expiresAt && new Date(r.expiresAt) <= now)
      .map(([userId]) => userId);
  }

  // ── Premium Roles ─────────────────────────────────────────────────────────

  getPremiumRole(roleId) {
    return this._data.premiumRoles[roleId] ?? null;
  }

  setPremiumRole(roleId, record) {
    this._data.premiumRoles[roleId] = record;
    this._save();
  }

  deletePremiumRole(roleId) {
    delete this._data.premiumRoles[roleId];
    this._save();
  }

  getAllPremiumRoles() {
    return Object.entries(this._data.premiumRoles).map(([roleId, r]) => ({ roleId, ...r }));
  }

  isRolePremium(roleId) {
    const r = this._data.premiumRoles[roleId];
    if (!r) return false;
    if (r.expiresAt && new Date(r.expiresAt) <= new Date()) return false;
    return true;
  }

  getExpiredPremiumRoles() {
    const now = new Date();
    return Object.entries(this._data.premiumRoles)
      .filter(([, r]) => r.expiresAt && new Date(r.expiresAt) <= now)
      .map(([roleId]) => roleId);
  }

  // ── Custom Limit Users ────────────────────────────────────────────────────

  getCustomLimitUser(userId) {
    const r = this._data.customLimitUsers[userId];
    if (!r) return null;
    if (r.expiresAt && new Date(r.expiresAt) <= new Date()) return null;
    return r;
  }

  /** Same as getCustomLimitUser but does NOT hide already-expired records —
   * used by the sweep to log an expiry's details before deleting it. */
  getRawCustomLimitUser(userId) {
    return this._data.customLimitUsers[userId] ?? null;
  }

  setCustomLimitUser(userId, record) {
    this._data.customLimitUsers[userId] = record;
    this._save();
  }

  deleteCustomLimitUser(userId) {
    delete this._data.customLimitUsers[userId];
    this._save();
  }

  getAllCustomLimitUsers() {
    return Object.entries(this._data.customLimitUsers).map(([userId, r]) => ({ userId, ...r }));
  }

  getExpiredCustomLimitUsers() {
    const now = new Date();
    return Object.entries(this._data.customLimitUsers)
      .filter(([, r]) => r.expiresAt && new Date(r.expiresAt) <= now)
      .map(([userId]) => userId);
  }

  // ── Custom Limit Roles ────────────────────────────────────────────────────

  getCustomLimitRole(roleId) {
    const r = this._data.customLimitRoles[roleId];
    if (!r) return null;
    if (r.expiresAt && new Date(r.expiresAt) <= new Date()) return null;
    return r;
  }

  /** Same as getCustomLimitRole but does NOT hide already-expired records —
   * used by the sweep to log an expiry's details before deleting it. */
  getRawCustomLimitRole(roleId) {
    return this._data.customLimitRoles[roleId] ?? null;
  }

  setCustomLimitRole(roleId, record) {
    this._data.customLimitRoles[roleId] = record;
    this._save();
  }

  deleteCustomLimitRole(roleId) {
    delete this._data.customLimitRoles[roleId];
    this._save();
  }

  getAllCustomLimitRoles() {
    return Object.entries(this._data.customLimitRoles).map(([roleId, r]) => ({ roleId, ...r }));
  }

  getExpiredCustomLimitRoles() {
    const now = new Date();
    return Object.entries(this._data.customLimitRoles)
      .filter(([, r]) => r.expiresAt && new Date(r.expiresAt) <= now)
      .map(([roleId]) => roleId);
  }

  // ── Premium Stats Dashboard (new /premstats panel) ───────────────────────

  /**
   * @returns {{ channelId: string|null, messageId: string|null }}
   */
  getPremStatsDashboardState() {
    return { channelId: null, messageId: null, ...this._data.premStatsDashboard };
  }

  /**
   * @param {{ channelId?: string|null, messageId?: string|null }} patch
   */
  setPremStatsDashboardState(patch) {
    this._data.premStatsDashboard = { ...this._data.premStatsDashboard, ...patch };
    this._save();
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  getDashboardMessageId() {
    return this._data.dashboard?.messageId ?? null;
  }

  setDashboardMessageId(id) {
    if (!this._data.dashboard) this._data.dashboard = {};
    this._data.dashboard.messageId = id;
    this._save();
  }

  /**
   * @returns {{ messageId: string|null, entryIndex: number }}
   */
  getDashboardState() {
    return { messageId: null, entryIndex: 0, ...this._data.dashboard };
  }

  /**
   * @param {{ messageId?: string|null, entryIndex?: number }} patch
   */
  setDashboardState(patch) {
    this._data.dashboard = { ...this._data.dashboard, ...patch };
    this._save();
  }

  // ── Last touched target (for the Monitoring dashboard) ───────────────────

  getLastPremiumTarget() {
    return this._data.lastPremiumTarget ?? null;
  }

  /** @param {string} mention e.g. "<@userId>" or "<@&roleId>" */
  setLastPremiumTarget(mention) {
    this._data.lastPremiumTarget = mention;
    this._save();
  }

  getLastCustomLimitTarget() {
    return this._data.lastCustomLimitTarget ?? null;
  }

  /** @param {string} mention e.g. "<@userId>" or "<@&roleId>" */
  setLastCustomLimitTarget(mention) {
    this._data.lastCustomLimitTarget = mention;
    this._save();
  }
}
