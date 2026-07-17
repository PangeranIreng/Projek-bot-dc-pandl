/**
 * src/features/luatools/api.js — API clients for Obfuscator and Deobfuscator.
 *
 * Environment variables required:
 *   LUA_OBFUSCATOR_API_URL   — Full POST endpoint URL for the obfuscator API
 *   LUA_OBFUSCATOR_API_KEY   — API key/token (sent as Authorization Bearer header)
 *   LUA_DEOBFUSCATOR_API_URL — Full POST endpoint URL for the deobfuscator API
 *   LUA_DEOBFUSCATOR_API_KEY — API key/token (sent as Authorization Bearer header)
 *
 * The API is expected to accept multipart/form-data with a field named "file"
 * containing the .lua file, and respond with:
 *   - Plain text (the processed Lua code), OR
 *   - JSON with a top-level "result", "code", or "output" string field.
 *
 * Timeout: 30 seconds per request.
 */

import { logger } from "../../utils/logger.js";

const TIMEOUT_MS = 30_000;

/**
 * Call a Lua processing API.
 * @param {"obfuscator"|"deobfuscator"} type
 * @param {Buffer} fileBuffer  Raw file bytes
 * @param {string} fileName    Original filename (e.g. "script.lua")
 * @returns {Promise<{ ok: true, result: Buffer } | { ok: false, error: string }>}
 */
export async function callLuaApi(type, fileBuffer, fileName) {
  const urlEnv = type === "obfuscator" ? "LUA_OBFUSCATOR_API_URL"   : "LUA_DEOBFUSCATOR_API_URL";
  const keyEnv = type === "obfuscator" ? "LUA_OBFUSCATOR_API_KEY"   : "LUA_DEOBFUSCATOR_API_KEY";
  const apiUrl = process.env[urlEnv];
  const apiKey = process.env[keyEnv];

  if (!apiUrl) {
    return {
      ok:    false,
      error: `${urlEnv} belum dikonfigurasi di Environment Variables.`,
    };
  }

  const label = type === "obfuscator" ? "Obfuscator" : "Deobfuscator";

  try {
    // Build multipart body
    const boundary = `----LuaToolsBoundary${Date.now()}`;
    const CRLF     = "\r\n";

    const header =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}` +
      `Content-Type: text/plain${CRLF}${CRLF}`;
    const footer = `${CRLF}--${boundary}--${CRLF}`;

    const bodyParts = [
      Buffer.from(header, "utf8"),
      fileBuffer,
      Buffer.from(footer, "utf8"),
    ];
    const body = Buffer.concat(bodyParts);

    const headers = {
      "Content-Type":   `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
      "User-Agent":     "LuaTools-Bot/1.0",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
      response = await fetch(apiUrl, {
        method:  "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.warn(`[LuaTools] ${label} API responded with ${response.status}: ${text.slice(0, 200)}`);
      return { ok: false, error: `API mengembalikan status ${response.status}.` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    let resultBuffer;

    if (contentType.includes("application/json")) {
      // JSON response — look for result/code/output field
      const json = await response.json();
      const code = json.result ?? json.code ?? json.output ?? json.script ?? null;
      if (typeof code !== "string") {
        logger.warn(`[LuaTools] ${label} API returned JSON without a recognized code field:`, json);
        return { ok: false, error: "API mengembalikan format yang tidak dikenali." };
      }
      resultBuffer = Buffer.from(code, "utf8");
    } else {
      // Plain text or binary — use as-is
      const arrayBuf = await response.arrayBuffer();
      resultBuffer   = Buffer.from(arrayBuf);
    }

    if (!resultBuffer.length) {
      return { ok: false, error: "API mengembalikan hasil kosong." };
    }

    return { ok: true, result: resultBuffer };

  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, error: "Request timeout — API tidak merespons dalam 30 detik." };
    }
    logger.error(`[LuaTools] ${label} API error:`, err);
    return { ok: false, error: "Gagal terhubung ke API." };
  }
}
