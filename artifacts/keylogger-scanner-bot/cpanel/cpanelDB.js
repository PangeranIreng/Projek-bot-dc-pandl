/**
 * cpanelDB.js — Persistent JSON storage for the CPanel system.
 *
 * Each panel has: id, channelId, messageId, guildId, title, description,
 * color, footer, thumbnail, banner, template, buttons (up to 5).
 *
 * Each button: { id, label, emoji, style, roleId, action }
 *   action: "toggle" (default) | "add" | "remove"
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "data", "cpanel-db.json");

const DEFAULT_DB = {
  // [ { id, guildId, channelId, messageId, title, description, color,
  //     footer, thumbnail, banner, template, buttons: [], createdBy, createdAt } ]
  panels: [],
  counter: 0,
};

export class CpanelDB {
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
        panels: Array.isArray(parsed.panels) ? parsed.panels : [],
      };
    } catch {
      return structuredClone(DEFAULT_DB);
    }
  }

  _save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this._data, null, 2), "utf8");
  }

  // ── Panel CRUD ────────────────────────────────────────────────────────────

  /** Generate a short unique panel ID: "cp-<counter>". */
  _nextId() {
    this._data.counter = (this._data.counter ?? 0) + 1;
    this._save();
    return `cp-${this._data.counter}`;
  }

  createPanel(panel) {
    const id = this._nextId();
    const record = {
      buttons:    [],
      thumbnail:  null,
      banner:     null,
      footer:     "Pangeran Assistant AI",
      color:      0x5865f2,
      template:   "custom",
      ...panel,
      id,
      createdAt: new Date().toISOString(),
    };
    this._data.panels.push(record);
    this._save();
    return record;
  }

  getPanel(id) {
    return this._data.panels.find((p) => p.id === id) ?? null;
  }

  getAllPanels(guildId = null) {
    if (!guildId) return [...this._data.panels];
    return this._data.panels.filter((p) => p.guildId === guildId);
  }

  updatePanel(id, patch) {
    const idx = this._data.panels.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    this._data.panels[idx] = { ...this._data.panels[idx], ...patch };
    this._save();
    return this._data.panels[idx];
  }

  deletePanel(id) {
    const idx = this._data.panels.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this._data.panels.splice(idx, 1);
    this._save();
    return true;
  }

  // ── Button helpers ────────────────────────────────────────────────────────

  addButton(panelId, button) {
    const panel = this.getPanel(panelId);
    if (!panel) return null;
    if (panel.buttons.length >= 5) return null; // max 5 buttons

    const btnId = `btn-${Date.now()}`;
    const record = { id: btnId, action: "toggle", ...button };
    panel.buttons.push(record);
    return this.updatePanel(panelId, { buttons: panel.buttons });
  }

  updateButton(panelId, btnId, patch) {
    const panel = this.getPanel(panelId);
    if (!panel) return null;
    const idx = panel.buttons.findIndex((b) => b.id === btnId);
    if (idx === -1) return null;
    panel.buttons[idx] = { ...panel.buttons[idx], ...patch };
    return this.updatePanel(panelId, { buttons: panel.buttons });
  }

  deleteButton(panelId, btnId) {
    const panel = this.getPanel(panelId);
    if (!panel) return null;
    const newBtns = panel.buttons.filter((b) => b.id !== btnId);
    if (newBtns.length === panel.buttons.length) return null;
    return this.updatePanel(panelId, { buttons: newBtns });
  }
}

export const cpanelDB = new CpanelDB();
