// Minimal, dependency-free setup web page shown only when BOT_TOKEN and/or
// SCAN_CHANNEL_ID are missing. Lets the user paste both values into a form
// instead of hand-editing Secrets, then writes them to the project's local
// `.env` file (never into source code, and `.env` is gitignored -- see
// artifacts/keylogger-scanner-bot/.gitignore). Node's built-in `http`
// module is used on purpose: this is a stopgap config page, not a real
// app, so no extra dependency is worth adding for it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page({ title, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0f1115;
    color: #e6e6e6;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 460px;
    background: #171a21;
    border: 1px solid #2a2e38;
    border-radius: 14px;
    padding: 32px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
  }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p.subtitle { margin: 0 0 24px; color: #9aa0ab; font-size: 14px; line-height: 1.5; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #cfd3db; }
  input[type="text"], input[type="password"] {
    width: 100%;
    padding: 11px 12px;
    margin-bottom: 18px;
    border-radius: 8px;
    border: 1px solid #333947;
    background: #0f1115;
    color: #e6e6e6;
    font-size: 14px;
  }
  input:focus { outline: 2px solid #5865F2; border-color: #5865F2; }
  .hint { font-size: 12px; color: #7a8090; margin: -14px 0 18px; }
  button {
    width: 100%;
    padding: 12px;
    border: none;
    border-radius: 8px;
    background: #5865F2;
    color: white;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: #4752c4; }
  .error {
    background: #3a1c1f;
    border: 1px solid #7a2c33;
    color: #ff9aa2;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    margin-bottom: 18px;
  }
  .success {
    background: #16301f;
    border: 1px solid #2d6b41;
    color: #86e5a3;
    padding: 14px 16px;
    border-radius: 8px;
    font-size: 14px;
    margin-bottom: 18px;
    line-height: 1.6;
  }
  code {
    background: #0f1115;
    border: 1px solid #333947;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
  .footnote { font-size: 12px; color: #6b7280; margin-top: 18px; line-height: 1.6; }
</style>
</head>
<body>
  <div class="card">${bodyHtml}</div>
</body>
</html>`;
}

function setupFormBody({ errorMessage = "", botTokenValue = "", scanChannelIdValue = "" } = {}) {
  const errorHtml = errorMessage
    ? `<div class="error">${escapeHtml(errorMessage)}</div>`
    : "";
  return `
    <h1>⚙️ Keylogger Scanner Bot — Setup</h1>
    <p class="subtitle">Secret yang diperlukan belum diisi. Masukkan token bot Discord dan channel ID yang ingin dipantau, lalu klik Save.</p>
    ${errorHtml}
    <form method="POST" action="/save">
      <label for="botToken">Discord Bot Token</label>
      <input type="password" id="botToken" name="botToken" value="${escapeHtml(botTokenValue)}" placeholder="Discord Developer Portal &gt; Bot &gt; Token" autocomplete="off" />
      <div class="hint">Dari Discord Developer Portal &gt; Applications &gt; Bot &gt; Token.</div>

      <label for="scanChannelId">Scan Channel ID</label>
      <input type="text" id="scanChannelId" name="scanChannelId" value="${escapeHtml(scanChannelIdValue)}" placeholder="Contoh: 1524816692943913020" autocomplete="off" />
      <div class="hint">Klik kanan channel Discord &gt; Copy Channel ID (butuh Developer Mode aktif).</div>

      <button type="submit">Save</button>
    </form>
    <p class="footnote">Nilai disimpan ke konfigurasi environment lokal proyek (<code>.env</code>), bukan ke dalam kode sumber, dan tidak pernah ditampilkan kembali di halaman ini.</p>
  `;
}

function successBody() {
  return `
    <h1>✅ Konfigurasi tersimpan</h1>
    <div class="success">
      BOT_TOKEN dan SCAN_CHANNEL_ID berhasil disimpan.<br />
      <strong>Restart workflow "Keylogger Scanner Bot"</strong> agar bot login dengan konfigurasi baru.
    </div>
    <p class="footnote">Setelah restart, jika kedua nilai valid, bot akan berjalan normal dan halaman setup ini tidak akan muncul lagi.</p>
  `;
}

function parseFormBody(body) {
  const params = new URLSearchParams(body);
  return {
    botToken: (params.get("botToken") || "").trim(),
    scanChannelId: (params.get("scanChannelId") || "").trim(),
  };
}

// Reads the existing .env file (if any) and returns it as a key -> raw-line
// map so unrelated existing entries are preserved, then writes back with
// BOT_TOKEN/SCAN_CHANNEL_ID set or replaced. Never touches source files.
function writeEnvValues({ botToken, scanChannelId }) {
  let existingLines = [];
  if (fs.existsSync(ENV_PATH)) {
    existingLines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
  }

  const keep = existingLines.filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("BOT_TOKEN=") && !trimmed.startsWith("SCAN_CHANNEL_ID=");
  });

  keep.push(`BOT_TOKEN=${botToken}`);
  keep.push(`SCAN_CHANNEL_ID=${scanChannelId}`);

  fs.writeFileSync(ENV_PATH, keep.join("\n") + "\n", { mode: 0o600 });
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Starts the setup HTTP server. Resolves with the server once it is
 * listening, or rejects if the port is unavailable (e.g. EADDRINUSE).
 * The caller is responsible for handling the rejection gracefully --
 * failing to start the setup page must never crash the bot process.
 * @param {number} port
 * @returns {Promise<http.Server>}
 */
export function startSetupServer(port) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page({ title: "Setup — Keylogger Scanner Bot", bodyHtml: setupFormBody() }));
        return;
      }

      if (req.method === "POST" && req.url === "/save") {
        const body = await readRequestBody(req);
        const { botToken, scanChannelId } = parseFormBody(body);

        if (!botToken || !scanChannelId) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            page({
              title: "Setup — Keylogger Scanner Bot",
              bodyHtml: setupFormBody({
                errorMessage: "Kedua field wajib diisi -- Discord Bot Token dan Scan Channel ID tidak boleh kosong.",
                botTokenValue: botToken,
                scanChannelIdValue: scanChannelId,
              }),
            }),
          );
          return;
        }

        writeEnvValues({ botToken, scanChannelId });
        logger.info("Konfigurasi BOT_TOKEN/SCAN_CHANNEL_ID disimpan via halaman setup. Restart workflow untuk menerapkannya.");

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page({ title: "Setup selesai — Keylogger Scanner Bot", bodyHtml: successBody() }));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (err) {
      logger.error("Kesalahan tak terduga di halaman setup", err);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal error saat menyimpan konfigurasi.");
    }
  });

  return new Promise((resolve, reject) => {
    // Attach the error handler BEFORE calling listen so EADDRINUSE and
    // similar errors reject the promise cleanly instead of becoming an
    // unhandled 'error' event that crashes the process.
    server.once("error", (err) => reject(err));
    server.listen(port, "0.0.0.0", () => {
      // Remove the one-shot error handler once we're safely listening.
      server.removeAllListeners("error");
      // Re-attach a permanent, non-crashing error handler for any errors
      // that occur after the server is already running (e.g. connection resets).
      server.on("error", (err) => logger.error("Setup server error", err));
      resolve(server);
    });
  });
}
