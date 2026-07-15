/**
 * config/settings.js — Static bot/scanner settings.
 * These limits are unrelated to secrets and safe to read once at import time.
 */

import "dotenv/config";

export const config = {
  // Discord's default non-Nitro upload cap.
  maxAttachmentSizeBytes: 25 * 1024 * 1024,
  // Guard rail for zip bombs: total decompressed bytes we scan in memory.
  maxTotalScanBytes: 60 * 1024 * 1024,
  // Per-entry cap inside a zip.
  maxEntrySizeBytes: 15 * 1024 * 1024,
  // Max entries inspected inside a single zip.
  maxZipEntries: 200,
  supportedExtensions: [
    ".lua", ".luac", ".js", ".py", ".txt", ".json",
    ".zip", ".rar", ".7z", ".exe", ".dll",
  ],
};
