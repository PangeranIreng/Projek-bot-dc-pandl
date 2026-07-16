/**
 * boomboxDB.js — Persistent JSON-based storage for BoomBox.
 * Survives restarts. All writes are synchronous for simplicity and safety.
 *
 * BoomBox V2: Added fields for channels, logChannel, maintenance, roleLimits.
 * All existing fields (settings.freeDailyLimit, dailyUsage, statistics,
 * history, logState, videoCache) are preserved as-is — no migration needed.
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOMBOX_CONFIG } from "../features/boombox/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "..", "data", "boombox-db.json");

const DEFAULT_DB = {
  settings: {
    freeDailyLimit: BOOMBOX_CONFIG.DEFAULT_FREE_DAILY_LIMIT,
    // V2: Per-platform channel IDs (null = belum di-setup)
    channels: {
      youtube: null,
      tiktok:  null,
      spotify: null,
    },
    // V2: Single log channel ID (null = belum di-setup, fallback ke config hardcode)
    logChannel: null,
    // V2: Maintenance per platform (false = aktif/normal)
    maintenance: {
      youtube: false,
      tiktok:  false,
      spotify: false,
    },
    // V2: Duration limit per role in MINUTES { "<roleId>": <minutes> }
    // Converts to seconds at runtime only. Null/absent = use default 25 min.
    roleLimits: {},
  },
  // { "YYYY-MM-DD": { userId: count } }
  dailyUsage: {},
  // Aggregated counters
  statistics: {
    total: 0,
    byPlatform: {},
  },
  // Last 500 entries — primary data source for BoomBox Logs Viewer (V2)
  history: [],
  // BoomBox Logs channel message tracking — single embed edited in place,
  // user-info-free public view of completed conversions.
  // { messageId: string|null, entries: Array<{title, platform, duration, boomboxUrl, timestamp}> }
  logState: {
    messageId: null,
    entries:   [],
  },
  // Persistent video cache — survives restarts.
  // { [videoId]: { boomboxUrl, title, duration, thumbnail, createdAt, lastUsed, hitCount } }
  videoCache: {},
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
      const def    = structuredClone(DEFAULT_DB);
      // Deep-merge defaults for any missing keys
      return {
        ...def,
        ...parsed,
        settings: {
          ...def.settings,
          ...(parsed.settings ?? {}),
          // V2 nested defaults — preserve existing while adding new fields
          channels: {
            ...def.settings.channels,
            ...(parsed.settings?.channels ?? {}),
          },
          maintenance: {
            ...def.settings.maintenance,
            ...(parsed.settings?.maintenance ?? {}),
          },
          roleLimits: {
            ...def.settings.roleLimits,
            ...(parsed.settings?.roleLimits ?? {}),
          },
        },
        logState: { ...def.logState, ...(parsed.logState ?? {}) },
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

  /**
   * V2: Get history filtered by platform, newest-first.
   * Used by BoomBox Logs Viewer — reads from history[] directly.
   * @param {"YouTube"|"TikTok"|"Spotify"|null} platform  null = semua platform
   * @returns {Array<object>}
   */
  getHistoryByPlatform(platform = null) {
    const h = this._data.history ?? [];
    const filtered = platform
      ? h.filter(e => e.platform === platform)
      : h;
    return [...filtered].reverse(); // newest-first, non-destructive
  }

  // ── Log message state ────────────────────────────────────────────────────

  getLogState() {
    const state = this._data.logState ?? {};
    return {
      messageId: state.messageId ?? null,
      entries:   Array.isArray(state.entries) ? state.entries : [],
    };
  }

  setLogState(patch) {
    this._data.logState = { ...this._data.logState, ...patch };
    this._save();
  }

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

  // ── V2: Channel config ───────────────────────────────────────────────────

  /**
   * Get configured channels per platform.
   * @returns {{ youtube: string|null, tiktok: string|null, spotify: string|null }}
   */
  getChannels() {
    return {
      youtube: null,
      tiktok:  null,
      spotify: null,
      ...(this._data.settings?.channels ?? {}),
    };
  }

  /**
   * Set the Discord channel for a specific platform.
   * @param {"youtube"|"tiktok"|"spotify"} platform
   * @param {string|null} channelId
   */
  setChannel(platform, channelId) {
    if (!this._data.settings.channels) this._data.settings.channels = {};
    this._data.settings.channels[platform] = channelId;
    this._save();
  }

  // ── V2: Log channel ──────────────────────────────────────────────────────

  /** @returns {string|null} */
  getLogChannel() {
    return this._data.settings?.logChannel ?? null;
  }

  /** @param {string|null} channelId */
  setLogChannel(channelId) {
    if (!this._data.settings) this._data.settings = {};
    this._data.settings.logChannel = channelId;
    this._save();
  }

  // ── V2: Maintenance ──────────────────────────────────────────────────────

  /**
   * Get maintenance status per platform.
   * @returns {{ youtube: boolean, tiktok: boolean, spotify: boolean }}
   */
  getMaintenance() {
    return {
      youtube: false,
      tiktok:  false,
      spotify: false,
      ...(this._data.settings?.maintenance ?? {}),
    };
  }

  /**
   * Set maintenance for a platform.
   * @param {"youtube"|"tiktok"|"spotify"} platform
   * @param {boolean} enabled
   */
  setMaintenance(platform, enabled) {
    if (!this._data.settings.maintenance) this._data.settings.maintenance = {};
    this._data.settings.maintenance[platform] = enabled;
    this._save();
  }

  /**
   * Toggle maintenance for a platform.
   * @param {"youtube"|"tiktok"|"spotify"} platform
   * @returns {boolean} New state
   */
  toggleMaintenance(platform) {
    const current = this.getMaintenance()[platform] ?? false;
    this.setMaintenance(platform, !current);
    return !current;
  }

  // ── V2: Role duration limits ─────────────────────────────────────────────

  /**
   * Get all role duration limits.
   * @returns {{ [roleId: string]: number }} roleId → minutes
   */
  getRoleLimits() {
    return { ...(this._data.settings?.roleLimits ?? {}) };
  }

  /**
   * Set video duration limit for a role.
   * @param {string} roleId
   * @param {number} minutes  Max video duration in minutes (stored as-is in DB)
   */
  setRoleLimit(roleId, minutes) {
    if (!this._data.settings.roleLimits) this._data.settings.roleLimits = {};
    this._data.settings.roleLimits[roleId] = minutes;
    this._save();
  }

  /**
   * Remove a role's duration limit (will use global default).
   * @param {string} roleId
   */
  deleteRoleLimit(roleId) {
    if (this._data.settings?.roleLimits?.[roleId] !== undefined) {
      delete this._data.settings.roleLimits[roleId];
      this._save();
    }
  }

  /**
   * Get effective max video duration in SECONDS for a GuildMember.
   * Picks the highest limit among member's roles.
   * Falls back to defaultSec if no role-specific limit configured.
   *
   * @param {import("discord.js").GuildMember} member
   * @param {number} defaultSec  Default in seconds (e.g. 25 * 60)
   * @returns {number}  Effective limit in seconds
   */
  getEffectiveDurationLimitSec(member, defaultSec = 25 * 60) {
    const limits = this._data.settings?.roleLimits ?? {};
    let maxMinutes = null;

    for (const [roleId, minutes] of Object.entries(limits)) {
      if (member.roles.cache.has(roleId)) {
        if (maxMinutes === null || minutes > maxMinutes) maxMinutes = minutes;
      }
    }

    return maxMinutes !== null ? maxMinutes * 60 : defaultSec;
  }

  // ── Video cache (persistent, survives restarts) ───────────────────────────

  getVideoCache(videoId) {
    return this._data.videoCache?.[videoId] ?? null;
  }

  setVideoCache(videoId, data) {
    if (!this._data.videoCache) this._data.videoCache = {};
    const existing = this._data.videoCache[videoId];
    this._data.videoCache[videoId] = {
      boomboxUrl: data.boomboxUrl,
      title:      data.title      ?? existing?.title      ?? null,
      duration:   data.duration   ?? existing?.duration   ?? null,
      thumbnail:  data.thumbnail  ?? existing?.thumbnail  ?? null,
      createdAt:  existing?.createdAt ?? Date.now(),
      lastUsed:   Date.now(),
      hitCount:   existing?.hitCount  ?? 0,
    };
    this._save();
  }

  updateVideoCacheHit(videoId) {
    const entry = this._data.videoCache?.[videoId];
    if (!entry) return;
    entry.hitCount = (entry.hitCount ?? 0) + 1;
    entry.lastUsed = Date.now();
    this._save();
  }

  cleanVideoCache(maxAgeDays = 90) {
    if (!this._data.videoCache) return 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed  = 0;
    for (const [id, entry] of Object.entries(this._data.videoCache)) {
      const lastActive = entry.lastUsed ?? entry.createdAt ?? 0;
      if (lastActive < cutoff) {
        delete this._data.videoCache[id];
        removed++;
      }
    }
    if (removed > 0) this._save();
    return removed;
  }

  getVideoCacheList(limit = 100) {
    const entries = Object.entries(this._data.videoCache ?? {})
      .map(([id, v]) => ({ videoId: id, ...v }))
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
    return entries.slice(0, limit);
  }
}
