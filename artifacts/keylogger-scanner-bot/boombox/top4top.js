/**
 * top4top.js — Upload a local file to top4top.io and return a permanent URL.
 * Retries up to MAX_RETRIES times on failure (network/server errors).
 */

import fs       from "node:fs";
import https    from "node:https";
import axios    from "axios";
import FormData from "form-data";
import { logger } from "../utils/logger.js";

const MAX_RETRIES   = 3;
const RETRY_DELAY   = 1500; // ms between retries

// Reused across every upload attempt/retry so we don't pay a fresh TCP+TLS
// handshake each time.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Upload a local file to top4top.io.
 *
 * @param {string} filePath  Absolute path to the local file to upload.
 * @returns {Promise<{ result: string, delete: string|null }>}
 * @throws  On network failure or when no URL is found in the response after all retries.
 */
export async function top4top(filePath) {
  const fileName = filePath.split("/").pop();
  const fileSize = (fs.statSync(filePath).size / 1024).toFixed(1);
  logger.info(`[top4top] ▶ Uploading: ${fileName} (${fileSize} KB)`);

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      logger.warn(`[top4top] Retry attempt ${attempt}/${MAX_RETRIES} after ${RETRY_DELAY}ms...`);
      await sleep(RETRY_DELAY);
    }

    try {
      const result = await _doUpload(filePath, fileName);
      if (attempt > 1) logger.info(`[top4top] Upload succeeded on attempt ${attempt}`);
      return result;
    } catch (err) {
      lastError = err;
      logger.warn(`[top4top] Attempt ${attempt} failed: ${err.message}`);

      // Don't retry on permanent client-side errors
      if (_isPermanentError(err)) {
        logger.error(`[top4top] Permanent error — not retrying.`);
        break;
      }
    }
  }

  throw lastError;
}

function _isPermanentError(err) {
  const msg = err.message ?? "";
  // 403 Forbidden, 404 Not Found — retrying won't help
  return msg.includes("HTTP 403") || msg.includes("HTTP 404");
}

async function _doUpload(filePath, fileName) {
  const form = new FormData();
  form.append("file_0_", fs.createReadStream(filePath), fileName);
  form.append("submitr", "[ رفع الملفات ]");

  let html;
  try {
    const res = await axios.post("https://top4top.io/index.php", form, {
      headers: {
        ...form.getHeaders(),
        "User-Agent": "Mozilla/5.0 (Linux; Android 10)",
        "Accept":     "text/html",
      },
      httpsAgent:       keepAliveAgent,
      timeout:          120_000,
      maxBodyLength:    Infinity,
      maxContentLength: Infinity,
    });

    logger.debug(`[top4top] HTTP ${res.status} — response length: ${String(res.data).length} chars`);
    html = res.data;
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.message || "";

    logger.error(`[top4top] Upload request failed: ${msg}`);
    if (err.response) {
      logger.debug(`[top4top] Response HTTP ${status}: ${String(err.response.data).slice(0, 300)}`);
    }

    if (status === 403) throw new Error("top4top upload ditolak (HTTP 403 Forbidden)");
    if (status === 404) throw new Error("top4top endpoint tidak ditemukan (HTTP 404)");
    if (status === 500) throw new Error("top4top server error (HTTP 500)");
    if (status >= 400)  throw new Error(`top4top mengembalikan HTTP ${status}`);
    if (err.code === "ECONNABORTED" || msg.includes("timeout"))
      throw new Error("top4top upload timeout — file mungkin terlalu besar");
    throw new Error(`top4top network error: ${msg.slice(0, 150)}`);
  }

  if (!html) throw new Error("top4top mengembalikan response kosong");

  // ── Extract URL from HTML ────────────────────────────────────────────────
  const get = (re) => {
    const m = String(html).match(re);
    return m ? (m[1] ?? m[0]) : null;
  };

  const result =
    get(/value="(https?:\/\/[a-z0-9]+\.top4top\.io\/m_[^"]+)"/)  ||
    get(/(https?:\/\/[a-z0-9]+\.top4top\.io\/m_[^\s"<>]+)/)       ||
    get(/value="(https?:\/\/[a-z0-9]+\.top4top\.io\/p_[^"]+)"/)  ||
    get(/(https?:\/\/[a-z0-9]+\.top4top\.io\/p_[^\s"<>]+)/);

  const del =
    get(/value="(https?:\/\/top4top\.io\/del[^"]+)"/)  ||
    get(/(https?:\/\/top4top\.io\/del[^\s"<>]+)/);

  if (!result) {
    const snippet = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .slice(0, 1500);
    logger.error(`[top4top] No URL found in response. HTML snippet:\n${snippet}`);
    throw new Error("top4top upload berhasil tapi tidak mengembalikan URL — coba lagi");
  }

  logger.info(`[top4top] ✅ Upload berhasil: ${result}`);
  return { result, delete: del };
}
