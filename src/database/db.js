/**
 * db.js — Shared singletons for BoomBox, Premium, and Lua Tools databases.
 *
 * Import from here instead of constructing instances directly so the entire
 * bot shares one in-memory cache per DB and avoids stale-read conflicts.
 */

import { BoomBoxDB }   from "./boomboxDB.js";
import { PremiumDB }   from "./premiumDB.js";
import { LuaToolsDB }  from "./luaToolsDB.js";

export const db     = new BoomBoxDB();
export const premDB = new PremiumDB();
export const ltDB   = new LuaToolsDB();
