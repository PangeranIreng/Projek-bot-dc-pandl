/**
 * boomboxErrorStore.js — Short-lived in-memory store for full BoomBox error
 * detail (stack trace / raw reason), keyed by a short id embedded in the
 * "🔍 Detail" button's customId.
 *
 * Why a separate store instead of putting the stack trace straight into the
 * failed embed: Discord channel messages must never carry a raw stack trace
 * (noisy, and a minor info leak) — only the error-log channel (utils/
 * errorLogger.js) and this on-demand ephemeral detail view should ever show
 * one. Entries expire after TTL so memory doesn't grow unbounded across a
 * long-running bot process.
 */

const TTL_MS   = 30 * 60 * 1000; // 30 minutes — long enough to click Detail
const MAX_KEEP = 500;

const store = new Map(); // id -> { message, stage, stack, timestamp }
let counter = 0;

/**
 * @param {{ message: string, stage: string, stack?: string }} detail
 * @returns {string} short id to embed in a button customId
 */
export function storeErrorDetail(detail) {
  const id = `${Date.now().toString(36)}${(counter++).toString(36)}`;
  store.set(id, { ...detail, timestamp: Date.now() });

  // Opportunistic cleanup — evict expired entries, then oldest-first if
  // still over the cap.
  for (const [k, v] of store) {
    if (Date.now() - v.timestamp > TTL_MS) store.delete(k);
  }
  while (store.size > MAX_KEEP) {
    store.delete(store.keys().next().value);
  }

  return id;
}

/** @returns {{message: string, stage: string, stack?: string}|null} */
export function getErrorDetail(id) {
  const hit = store.get(id);
  if (!hit) return null;
  if (Date.now() - hit.timestamp > TTL_MS) {
    store.delete(id);
    return null;
  }
  return hit;
}
