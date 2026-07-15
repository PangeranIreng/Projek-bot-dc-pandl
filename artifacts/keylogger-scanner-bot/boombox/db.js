/**
 * db.js — Shared singletons for BoomBox and Premium databases.
 *
 * Import from here instead of constructing instances directly so the entire
 * bot shares one in-memory cache per DB and avoids stale-read conflicts.
 */

import { BoomBoxDB } from "./boomboxDB.js";
import { PremiumDB } from "./premiumDB.js";

export const db     = new BoomBoxDB();
export const premDB = new PremiumDB();
