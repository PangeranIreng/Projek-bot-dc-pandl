// In-memory store mapping a short-lived scanId to the raw buffer/fileName/
// result of a scan, so button interactions (Full Preview, Download Preview,
// Copy Webhook, Copy Indicators, Scan Again) can retrieve that context
// without re-scanning. Entries expire on their own via TTL -- nothing here
// is persisted to disk, so a bot restart naturally clears it (matches the
// existing "no external state" design of the rest of the bot).

import { randomUUID } from "node:crypto";

const TTL_MS = 30 * 60 * 1000; // 30 minutes -- long enough for a user to click a button, short enough not to leak memory
const store = new Map();

/**
 * @param {{buffer: Buffer, fileName: string, result: object}} context
 * @returns {string} scanId
 */
export function saveScanContext(context) {
  const scanId = randomUUID();
  const timeout = setTimeout(() => store.delete(scanId), TTL_MS);
  store.set(scanId, { ...context, timeout });
  return scanId;
}

/**
 * @param {string} scanId
 * @returns {{buffer: Buffer, fileName: string, result: object} | undefined}
 */
export function getScanContext(scanId) {
  return store.get(scanId);
}

export function deleteScanContext(scanId) {
  const entry = store.get(scanId);
  if (entry?.timeout) clearTimeout(entry.timeout);
  store.delete(scanId);
}
