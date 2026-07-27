/**
 * ffmpegPath.js — Resolve a working ffmpeg binary path once at startup.
 *
 * Resolution order (highest → lowest preference):
 *   1. System ffmpeg found via `which ffmpeg`  (fastest; available on Replit
 *      dev env, standard Linux VPS, Render with build pack, etc.)
 *   2. ffmpeg-static npm bundle  (pre-built binary shipped with the npm
 *      package; works on Railway, Render, and any host without a system ffmpeg)
 *   3. Hard-coded fallback "ffmpeg"  (last resort — may still fail if truly
 *      absent, but we never throw from this module)
 *
 * Exported value:
 *   FFMPEG_PATH  — absolute path string (or "ffmpeg" as last resort)
 *   ffmpegAvailable — boolean; true when we confirmed a binary exists
 */

import { execSync }    from "node:child_process";
import { existsSync }  from "node:fs";
import { createRequire } from "node:module";
import { logger }      from "./logger.js";

const _require = createRequire(import.meta.url);

function _resolve() {
  // ── 1. System ffmpeg ──────────────────────────────────────────────────────
  try {
    const p = execSync("which ffmpeg", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (p && existsSync(p)) {
      logger.info(`[ffmpegPath] Using system ffmpeg: ${p}`);
      return { path: p, available: true };
    }
  } catch { /* not in PATH */ }

  // ── 2. ffmpeg-static npm bundle ──────────────────────────────────────────
  try {
    // ffmpeg-static is a CJS package that returns the binary path as its default
    // export. We load it via createRequire so this ESM module can access it.
    const staticPath = _require("ffmpeg-static");
    if (staticPath && existsSync(staticPath)) {
      logger.info(`[ffmpegPath] Using ffmpeg-static bundle: ${staticPath}`);
      return { path: staticPath, available: true };
    }
    if (staticPath) {
      // Package installed but binary not yet extracted (rare edge case).
      logger.warn(`[ffmpegPath] ffmpeg-static path reported but binary missing: ${staticPath}`);
    }
  } catch (e) {
    logger.warn(`[ffmpegPath] ffmpeg-static not loadable: ${e.message}`);
  }

  // ── 3. Last resort ───────────────────────────────────────────────────────
  logger.warn("[ffmpegPath] No ffmpeg binary found — audio conversion will fail if needed");
  return { path: "ffmpeg", available: false };
}

const resolved       = _resolve();
export const FFMPEG_PATH      = resolved.path;
export const ffmpegAvailable  = resolved.available;
