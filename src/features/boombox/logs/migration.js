/**
 * boombox/logs/migration.js — BoomBox Logs V2 one-time migration.
 *
 * Dijalankan SATU KALI saat bot ready. Flag tersimpan di DB.
 *
 * Yang dilakukan:
 *   1. Ambil entri lama dari logState.entries → masukkan ke history[] (dedup by boomboxUrl)
 *   2. Scan pesan lama di log channel → parse entri → masukkan ke history[] (dedup)
 *   3. Hapus semua pesan lama (non-panel) di log channel
 *   4. Pastikan panel BoomBox Logs V2 ada (satu pesan, edit bukan buat baru)
 *   5. Tandai migrationV2Done = true
 */

import { db }                   from "../../../database/db.js";
import { logger }               from "../../../utils/logger.js";
import { buildPublicLogPanel }  from "./viewer.js";
import { BOOMBOX_CONFIG }       from "../config.js";

// Regex untuk mendeteksi BoomBox/Top4Top URL di dalam embed
const BOOMBOX_URL_RE = /https?:\/\/[^\s<>"']+top4top\.[^\s<>"']+/gi;

/** @param {string} url */
function cleanBoomboxUrl(url) {
  return url.replace(/[)>\]'"]+$/, "").trim();
}

/**
 * Coba ekstrak entry BoomBox dari sebuah Discord Message.
 * Mendukung format lama (embed paginated dashboard) maupun format
 * individual message dengan embed field URL.
 *
 * @param {import("discord.js").Message} msg
 * @returns {Array<{title:string,platform:string,boomboxUrl:string,timestamp:string}>}
 */
function extractEntriesFromMessage(msg) {
  const results = [];

  for (const embed of msg.embeds) {
    const desc    = embed.description ?? "";
    const allText = [
      embed.title ?? "",
      desc,
      ...embed.fields.map(f => `${f.name}\n${f.value}`),
    ].join("\n");

    // Find all top4top URLs in the full text
    const rawUrls = allText.match(BOOMBOX_URL_RE) ?? [];
    if (rawUrls.length === 0) continue;

    // Detect platform from title / text
    let platform = "YouTube";
    const lower  = allText.toLowerCase();
    if (lower.includes("tiktok"))  platform = "TikTok";
    else if (lower.includes("spotify")) platform = "Spotify";

    // Parse individual numbered blocks from old paginated-dashboard format:
    //   **N.**\n🎵 Title\n🔗 url\n🕒 date
    const blockRe = /\*\*\d+\.\*\*\s*\n?🎵\s*(.+?)\n🔗\s*(https?:\/\/\S+)\n(?:🕒\s*(.+))?/gm;
    let m;
    let matched = false;
    while ((m = blockRe.exec(desc)) !== null) {
      const title      = m[1]?.trim() ?? "Unknown";
      const boomboxUrl = cleanBoomboxUrl(m[2] ?? "");
      const rawDate    = m[3]?.trim();
      const timestamp  = rawDate ? _parseWIBDate(rawDate) : (msg.createdAt?.toISOString() ?? new Date().toISOString());
      if (boomboxUrl) {
        results.push({ title, platform, boomboxUrl, timestamp });
        matched = true;
      }
    }

    // If block regex didn't match anything but we found top4top URLs, add them as minimal entries
    if (!matched) {
      for (const rawUrl of rawUrls) {
        const boomboxUrl = cleanBoomboxUrl(rawUrl);
        const title      = embed.title?.replace(/^\s*📻\s*BoomBox\s*Logs?\s*/i, "").trim() || "Unknown";
        const timestamp  = msg.createdAt?.toISOString() ?? new Date().toISOString();
        results.push({ title, platform, boomboxUrl, timestamp });
      }
    }
  }

  return results;
}

/**
 * Parse a WIB-formatted date string "DD/MM/YYYY HH:MM WIB" into an ISO string.
 * Falls back to current time on failure.
 * @param {string} raw
 * @returns {string}
 */
function _parseWIBDate(raw) {
  try {
    const m = /(\d{2})\/(\d{2})\/(\d{4})\s+•?\s*(\d{2}):(\d{2})/.exec(raw);
    if (!m) return new Date().toISOString();
    const [, dd, mm, yyyy, hh, min] = m;
    // WIB = UTC+7
    const utcMs = Date.UTC(+yyyy, +mm - 1, +dd, +hh - 7, +min);
    return new Date(utcMs).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Merge entries from logState.entries (old paginated dashboard storage)
 * into history[] — dedup by boomboxUrl.
 * @param {Set<string>} seenUrls — grows in place
 * @returns {number} entries added
 */
function _migrateLogStateEntries(seenUrls) {
  const { entries } = db.getLogState();
  if (!Array.isArray(entries) || entries.length === 0) return 0;

  let added = 0;
  for (const e of entries) {
    const url = e.boomboxUrl;
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    db.addHistory({
      platform:  e.platform ?? "YouTube",
      title:     e.title    ?? "Unknown",
      boomboxUrl: url,
      duration:  e.duration ?? null,
      timestamp: e.timestamp ?? new Date().toISOString(),
      // migrasi — tidak ada userId / originalUrl
      userId:         "_migrated_",
      originalUrl:    url,
      limitRemaining: "-",
    });
    added++;
  }
  return added;
}

/**
 * Main migration function. Call once from ready.js.
 *
 * Idempotency contract:
 *   - `migrationV2Done` is set to true ONLY after all steps complete without
 *     a fatal failure. Any error (channel not found, not text-based, API
 *     failure) leaves the flag unset so the next bot restart retries the
 *     migration automatically.
 *   - Partial history ingestion is safe: dedup by boomboxUrl means repeated
 *     runs never create duplicates — only entries not yet in history are added.
 *
 * @param {import("discord.js").Client} client
 */
export async function runBoomBoxLogsMigrationV2(client) {
  if (db.getMigrationV2Done()) {
    logger.debug("[BoomBox Migration] V2 migration already done — skipping.");
    return;
  }

  const logChannelId = db.getLogChannel?.() ?? BOOMBOX_CONFIG.BOOMBOX_LOG_CHANNEL_ID;
  if (!logChannelId) {
    // Log channel not yet configured — defer without setting the done flag.
    // Migration retries automatically every restart until channel is set.
    logger.warn("[BoomBox Migration] Log channel belum dikonfigurasi — migrasi ditunda. Jalankan /setupboombox → Ganti Log Channel, lalu restart bot.");
    return;
  }

  logger.info(`[BoomBox Migration] Memulai migrasi BoomBox Logs ke V2... (channel: ${logChannelId})`);

  // ── Step 1: migrate logState.entries → history ───────────────────────────
  const existingHistory = db.getHistoryByPlatform(null);
  const seenUrls = new Set(existingHistory.map(e => e.boomboxUrl).filter(Boolean));

  const fromLogState = _migrateLogStateEntries(seenUrls);
  logger.info(`[BoomBox Migration] Step 1 — logState.entries: ${fromLogState} entri baru ditambahkan.`);

  // ── Step 2 & 3 & 4: channel scan + cleanup + panel ───────────────────────
  let channelAdded  = 0;
  let channelDeleted = 0;

  // Resolve the channel; treat failure as a deferred migration (not done).
  const ch = await client.channels.fetch(logChannelId).catch(() => null);
  if (!ch?.isTextBased()) {
    logger.warn(
      `[BoomBox Migration] Log channel ${logChannelId} tidak ditemukan atau bukan text channel. ` +
      "Migrasi ditunda — akan dicoba ulang pada restart berikutnya."
    );
    return; // do NOT set migrationV2Done — try again next startup
  }

  const state = db.getLogState();

  try {
    // ── Step 2: scan ALL messages (unbounded, paginate to end of history) ──
    let lastId = undefined;
    const messagesToDelete = [];
    let batchNum = 0;

    while (true) {
      batchNum++;
      const fetchOptions = { limit: 100 };
      if (lastId) fetchOptions.before = lastId;

      // A null result here (network/permission error) is fatal for this run —
      // propagate to outer catch so we do NOT set migrationV2Done.
      const msgs = await ch.messages.fetch(fetchOptions);
      if (!msgs || msgs.size === 0) break;

      logger.debug(`[BoomBox Migration] Batch ${batchNum}: scanning ${msgs.size} messages`);

      for (const [id, msg] of msgs) {
        if (state.messageId && id === state.messageId) continue; // skip current panel

        const entries = extractEntriesFromMessage(msg);
        for (const entry of entries) {
          if (!seenUrls.has(entry.boomboxUrl)) {
            seenUrls.add(entry.boomboxUrl);
            db.addHistory({
              platform:       entry.platform,
              title:          entry.title,
              boomboxUrl:     entry.boomboxUrl,
              duration:       null,
              timestamp:      entry.timestamp,
              userId:         "_migrated_",
              originalUrl:    entry.boomboxUrl,
              limitRemaining: "-",
            });
            channelAdded++;
          }
        }

        const isBotMsg = msg.author?.id === client.user?.id;
        if (isBotMsg || entries.length > 0) messagesToDelete.push(msg);
      }

      lastId = msgs.last()?.id;
      if (msgs.size < 100) break; // reached the beginning of channel history
    }

    logger.info(`[BoomBox Migration] Step 2 — ${batchNum} batch(es), ${channelAdded} entri baru, ${messagesToDelete.length} pesan lama ditemukan.`);

    // ── Step 3: delete old messages ─────────────────────────────────────────
    for (const msg of messagesToDelete) {
      try {
        await msg.delete();
        channelDeleted++;
      } catch (e) {
        // Individual delete failures are non-fatal (e.g. already deleted, no
        // permission for one message). Log and continue; migration still succeeds.
        logger.warn(`[BoomBox Migration] Gagal hapus pesan ${msg.id}: ${e.message}`);
      }
    }
    logger.info(`[BoomBox Migration] Step 3 — dihapus ${channelDeleted}/${messagesToDelete.length} pesan lama.`);

    // ── Step 4: ensure one V2 panel exists ──────────────────────────────────
    const panelPayload = buildPublicLogPanel();
    if (state.messageId) {
      try {
        const existing = await ch.messages.fetch(state.messageId);
        await existing.edit(panelPayload);
        logger.info("[BoomBox Migration] Step 4 — Panel V2 di-edit (sudah ada).");
      } catch {
        // Panel deleted along with old messages — create fresh.
        const newMsg = await ch.send(panelPayload);
        db.setLogState({ messageId: newMsg.id });
        logger.info(`[BoomBox Migration] Step 4 — Panel V2 baru dibuat: ${newMsg.id}`);
      }
    } else {
      const newMsg = await ch.send(panelPayload);
      db.setLogState({ messageId: newMsg.id });
      logger.info(`[BoomBox Migration] Step 4 — Panel V2 baru dibuat: ${newMsg.id}`);
    }

  } catch (err) {
    // Any fatal error during scan/cleanup/panel leaves migrationV2Done unset
    // so the next restart will retry the full migration cleanly.
    logger.error(
      `[BoomBox Migration] ❌ Fatal error — migrasi ditunda, akan dicoba ulang pada restart berikutnya: ${err.message}`
    );
    return;
  }

  // ── Step 5: mark done — only reached on full success ────────────────────
  db.setMigrationV2Done(true);

  const totalAdded = fromLogState + channelAdded;
  logger.info(
    `[BoomBox Migration] ✅ Selesai — ${totalAdded} entri baru ditambahkan, ` +
    `${channelDeleted} pesan lama dihapus.`
  );
}
