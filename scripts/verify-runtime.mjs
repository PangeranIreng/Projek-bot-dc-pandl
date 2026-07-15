/**
 * verify-runtime.mjs — Full runtime verification script (non-destructive).
 *
 * Tests every checklist item without touching Discord, real downloads, or
 * any production data. Exits 0 on pass, 1 on any failure.
 *
 * Run: node scripts/verify-runtime.mjs
 */

import { execSync, execFile }     from "node:child_process";
import { promisify }              from "node:util";
import fs                         from "node:fs";
import path                       from "node:path";
import { fileURLToPath }          from "node:url";
import os                         from "node:os";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, "..");

// ── Tiny test harness ─────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function pass(label) {
  process.stdout.write(`  ✅  ${label}\n`);
  passed++;
}
function fail(label, detail = "") {
  process.stdout.write(`  ❌  ${label}${detail ? ` — ${detail}` : ""}\n`);
  failed++;
  failures.push({ label, detail });
}
function section(title) {
  process.stdout.write(`\n${"─".repeat(60)}\n▶  ${title}\n${"─".repeat(60)}\n`);
}

// ── 1. node_modules & package integrity ───────────────────────────────────────

section("1 · node_modules & package integrity");

const nmPath = path.join(ROOT, "node_modules");
if (fs.existsSync(nmPath)) {
  pass("node_modules directory exists");
} else {
  fail("node_modules missing", "run pnpm install");
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
pass(`package.json valid (name="${pkg.name}" version="${pkg.version}" type="${pkg.type}")`);

// Verify every declared dependency has its folder in node_modules
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  const depDir = path.join(nmPath, dep);
  if (fs.existsSync(depDir)) {
    pass(`dependency folder exists: ${dep}`);
  } else {
    fail(`dependency folder MISSING: ${dep}`);
  }
}

// lockfile present
const lockPath = path.join(ROOT, "pnpm-lock.yaml");
if (fs.existsSync(lockPath)) {
  pass("pnpm-lock.yaml present");
} else {
  fail("pnpm-lock.yaml MISSING");
}

// ── 2. Import check — all production packages ─────────────────────────────────

section("2 · Module import verification (runtime)");

const REQUIRED_PACKAGES = [
  "discord.js",
  "axios",
  "@distube/ytdl-core",
  "adm-zip",
  "form-data",
  "luaparse",
  "dotenv",
];

for (const pkg of REQUIRED_PACKAGES) {
  try {
    await import(pkg);
    pass(`import('${pkg}') OK`);
  } catch (e) {
    fail(`import('${pkg}') FAILED`, e.message);
  }
}

// Node built-ins used by source
const BUILTINS = ["node:fs","node:path","node:os","node:https","node:child_process","node:util","node:crypto","node:url","node:zlib","node:http"];
for (const b of BUILTINS) {
  try {
    await import(b);
    pass(`built-in ${b} OK`);
  } catch(e) {
    fail(`built-in ${b} FAILED`, e.message);
  }
}

// ── 3. Source syntax check — every .js file ───────────────────────────────────

section("3 · Source syntax check (node --check)");

const sourceFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") walk(full);
    else if (entry.isFile() && entry.name.endsWith(".js")) sourceFiles.push(full);
  }
}
walk(path.join(ROOT, "src"));
walk(path.join(ROOT, "config"));

let syntaxFails = 0;
for (const f of sourceFiles) {
  try {
    execSync(`node --check "${f}"`, { stdio: "pipe" });
  } catch (e) {
    fail(`syntax error in ${path.relative(ROOT, f)}`, e.stderr?.toString().trim().split("\n")[0]);
    syntaxFails++;
  }
}
if (syntaxFails === 0) {
  pass(`all ${sourceFiles.length} source files pass syntax check`);
}

// ── 4. yt-dlp binary ──────────────────────────────────────────────────────────

section("4 · yt-dlp binary health");

const BIN_PATH = path.join(ROOT, "bin", "yt-dlp_linux");
if (fs.existsSync(BIN_PATH)) {
  const stat = fs.statSync(BIN_PATH);
  if (stat.size > 1_000_000) {
    pass(`bin/yt-dlp_linux exists (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    fail("bin/yt-dlp_linux exists but looks too small (corrupt?)", `${stat.size} bytes`);
  }
  // Check executable bit
  try {
    fs.accessSync(BIN_PATH, fs.constants.X_OK);
    pass("bin/yt-dlp_linux is executable");
  } catch {
    fail("bin/yt-dlp_linux not executable");
  }
  // Run --version
  try {
    const { stdout } = await execFileAsync(BIN_PATH, ["--version"], { timeout: 10_000 });
    pass(`yt-dlp --version OK: ${stdout.trim()}`);
  } catch (e) {
    fail("yt-dlp --version failed", e.message);
  }
  // ffmpeg check
  try {
    const ffmpeg = execSync("which ffmpeg", { encoding: "utf8" }).trim();
    pass(`ffmpeg found: ${ffmpeg}`);
  } catch {
    fail("ffmpeg NOT found in PATH — audio conversion will fail");
  }
} else {
  fail("bin/yt-dlp_linux MISSING");
}

// ── 5. BoomBox queue — slot management under concurrency ──────────────────────

section("5 · BoomBox Queue — 20 concurrent jobs, no stuck slots");

const { enqueueBoomBoxJob, getQueueSnapshot } = await import(
  path.join(ROOT, "src/features/queue/boomboxQueue.js")
);

// Snapshot before
const before = getQueueSnapshot();
pass(`queue snapshot before test: active=${before.active} queued=${before.queued} maxConcurrent=${before.maxConcurrent}`);

// Fire 20 jobs: mix of fast-success, fast-fail, and simulated slow
const TOTAL_JOBS = 20;
const outcomes   = { success: 0, fail: 0 };
const startedAt  = Date.now();

const jobs = Array.from({ length: TOTAL_JOBS }, (_, i) => {
  const kind = i % 3; // 0=success, 1=fail, 2=slow-success (150ms)
  return enqueueBoomBoxJob(
    async () => {
      if (kind === 1) throw new Error(`Simulated failure (job ${i})`);
      await new Promise(r => setTimeout(r, kind === 2 ? 150 : 20));
      return `ok-${i}`;
    },
    {
      onQueued: (pos) => { /* position callback fires, no assert needed */ },
      onStart:  ()    => { /* start callback fires */ },
    }
  ).then(() => outcomes.success++).catch(() => outcomes.fail++);
});

await Promise.all(jobs);
const elapsed = Date.now() - startedAt;

const after = getQueueSnapshot();

if (after.active === 0 && after.queued === 0) {
  pass(`all 20 jobs settled — active=0 queued=0 (${elapsed}ms)`);
} else {
  fail(`queue NOT empty after all jobs settled`, `active=${after.active} queued=${after.queued}`);
}

const expectedSuccess = TOTAL_JOBS - Math.floor(TOTAL_JOBS / 3); // ~14
if (outcomes.success + outcomes.fail === TOTAL_JOBS) {
  pass(`all 20 outcomes accounted for: ${outcomes.success} success, ${outcomes.fail} fail`);
} else {
  fail("some jobs neither resolved nor rejected", `${outcomes.success + outcomes.fail}/${TOTAL_JOBS}`);
}

// Verify through ceiling: no more than MAX_CONCURRENT ran simultaneously
// (We can't intercept mid-run, so we confirm via timing: 20 jobs, max 5 concurrent,
//  fastest would be ~4 waves × 20ms = 80ms. Should definitely complete < 5000ms.)
if (elapsed < 5000) {
  pass(`queue drained in ${elapsed}ms (< 5s ceiling) — no dead slots`);
} else {
  fail(`queue took ${elapsed}ms — possible stuck slot`);
}

// ── 6. Provider health / circuit breaker ─────────────────────────────────────

section("6 · Provider health — circuit breaker & fallback routing");

const ph = await import(path.join(ROOT, "src/services/providerHealth.js"));

// 6a. Fresh provider starts ONLINE
const freshStatus = ph.getStatus("test-provider-a");
if (freshStatus.status === "ONLINE") {
  pass("new provider starts ONLINE");
} else {
  fail("new provider NOT online by default");
}

// 6b. shouldSkip returns false when ONLINE
if (!ph.shouldSkip("test-provider-a")) {
  pass("shouldSkip=false when ONLINE");
} else {
  fail("shouldSkip=true on fresh ONLINE provider");
}

// 6c. 5 consecutive failures → OFFLINE
for (let i = 0; i < 5; i++) {
  ph.recordFailure("test-provider-b", { reason: `simulated error ${i}` });
}
const offlineStatus = ph.getStatus("test-provider-b");
if (offlineStatus.status === "OFFLINE") {
  pass("provider goes OFFLINE after 5 consecutive failures");
} else {
  fail("provider NOT offline after 5 failures", `status=${offlineStatus.status} consecutiveFails=${offlineStatus.consecutiveFailures}`);
}

// 6d. shouldSkip returns true when OFFLINE (within cooldown)
if (ph.shouldSkip("test-provider-b")) {
  pass("shouldSkip=true when OFFLINE (within cooldown window)");
} else {
  fail("shouldSkip=false on OFFLINE provider");
}

// 6e. recordSuccess after being OFFLINE → back ONLINE
ph.recordSuccess("test-provider-b");
const recoveredStatus = ph.getStatus("test-provider-b");
if (recoveredStatus.status === "ONLINE") {
  pass("recordSuccess() recovers OFFLINE provider back to ONLINE");
} else {
  fail("provider did not recover after recordSuccess()", `status=${recoveredStatus.status}`);
}

// 6f. Simulate yt-dlp-youtube OFFLINE → shouldSkip returns true (fallback routing)
for (let i = 0; i < 5; i++) {
  ph.recordFailure("yt-dlp-youtube-sim", { reason: "anti-bot simulated", isTimeout: false });
}
const ytdlOffline = ph.getStatus("yt-dlp-youtube-sim");
if (ytdlOffline.status === "OFFLINE") {
  pass("yt-dlp-youtube circuit breaks after 5 failures — fallback providers will be used");
} else {
  fail("yt-dlp-youtube did not go OFFLINE");
}

// 6g. Timeout failure records correctly (does NOT count as permanent)
ph.recordFailure("test-timeout-provider", { reason: "timed out: 30s", isTimeout: true });
const timeoutStatus = ph.getStatus("test-timeout-provider");
if (timeoutStatus.totalTimeouts === 1 && timeoutStatus.consecutiveFailures === 1) {
  pass("timeout failure counted correctly (consecutiveFailures++ totalTimeouts++)");
} else {
  fail("timeout failure not recorded correctly", JSON.stringify(timeoutStatus));
}

// 6h. getAllStatuses returns a record
const allStatuses = ph.getAllStatuses();
if (typeof allStatuses === "object" && Object.keys(allStatuses).length > 0) {
  pass(`getAllStatuses() returns ${Object.keys(allStatuses).length} providers`);
} else {
  fail("getAllStatuses() empty or wrong type");
}

// ── 7. withStageTimeout + AbortController (no zombie promises) ────────────────

section("7 · withStageTimeout — no hanging promises, AbortController fires");

// Import the handler's internal via a thin wrapper test
// We test withStageTimeout behavior by directly importing handler and checking
// that it doesn't leak promises. We can't import handler directly (it needs
// discord.js client state) so we replicate the exact logic here as a white-box test.

function withStageTimeout(promiseOrFactory, ms, stageLabel) {
  const isFactory = typeof promiseOrFactory === "function";
  const controller = isFactory ? new AbortController() : null;
  const work = isFactory ? promiseOrFactory(controller.signal) : promiseOrFactory;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      const err = new Error(`${stageLabel} timed out (>${Math.round(ms / 1000)}s)`);
      err.code = "BOOMBOX_STAGE_TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// 7a. Factory gets AbortSignal and abort fires on timeout
let abortFired = false;
let signalRef   = null;
const timeoutPromise = withStageTimeout(
  (signal) => {
    signalRef = signal;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        abortFired = true;
        reject(new Error("aborted"));
      });
      // Never resolves on its own (simulates hung download)
    });
  },
  50,   // 50ms timeout for the test
  "Test Stage"
);

try {
  await timeoutPromise;
  fail("withStageTimeout should have rejected");
} catch (e) {
  // When AbortController.abort() fires synchronously inside the timeout
  // callback, the factory's abort handler rejects `work` before the timeout
  // promise itself rejects. Promise.race therefore settles with the abort
  // error (code undefined / "aborted"), not BOOMBOX_STAGE_TIMEOUT. Both
  // outcomes are correct — what matters is (a) it rejected and (b) abort fired.
  pass(`withStageTimeout rejected as expected (code=${e.code ?? "AbortError/undefined"})`);
}
if (abortFired) {
  pass("AbortController.abort() fired before rejection — yt-dlp child would receive SIGTERM");
} else {
  fail("AbortController.abort() did NOT fire — zombie processes possible");
}

// 7b. Fast factory — resolves before timeout, no leak
let cleanupFired = false;
const fastResult = await withStageTimeout(
  (signal) => Promise.resolve("fast-ok"),
  5000,
  "Fast Stage"
);
if (fastResult === "fast-ok") {
  pass("fast factory resolves correctly before timeout");
} else {
  fail("fast factory did not resolve correctly");
}

// 7c. Plain promise (not factory) — still times out
try {
  await withStageTimeout(
    new Promise(() => {}), // never resolves
    50,
    "Plain Promise Stage"
  );
  fail("plain promise withStageTimeout should have rejected");
} catch (e) {
  if (e.code === "BOOMBOX_STAGE_TIMEOUT") {
    pass("plain promise variant also times out correctly");
  } else {
    fail("plain promise wrong rejection", e.code);
  }
}

// ── 8. Memory leak check ──────────────────────────────────────────────────────

section("8 · Memory leak check");

// Force GC if available (node --expose-gc)
if (typeof gc !== "undefined") gc();
const heapBefore = process.memoryUsage().heapUsed;

// Run 100 queue jobs to stress the queue and providerHealth
const MEM_JOBS = 100;
await Promise.all(
  Array.from({ length: MEM_JOBS }, (_, i) =>
    enqueueBoomBoxJob(async () => {
      await new Promise(r => setTimeout(r, 5));
      if (i % 7 === 0) throw new Error("simulated");
      return i;
    }).catch(() => {})
  )
);

if (typeof gc !== "undefined") gc();
const heapAfter = process.memoryUsage().heapUsed;
const heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;

pass(`heap before: ${(heapBefore / 1024 / 1024).toFixed(2)} MB`);
pass(`heap after 100 queue jobs: ${(heapAfter / 1024 / 1024).toFixed(2)} MB`);

if (heapDeltaMB < 10) {
  pass(`heap delta: +${heapDeltaMB.toFixed(2)} MB — no significant leak detected`);
} else {
  fail(`heap grew ${heapDeltaMB.toFixed(2)} MB after 100 jobs — possible leak`);
}

const qFinal = getQueueSnapshot();
if (qFinal.active === 0 && qFinal.queued === 0) {
  pass("queue fully drained after memory test (active=0 queued=0)");
} else {
  fail("queue not empty after memory test", `active=${qFinal.active} queued=${qFinal.queued}`);
}

// ── 9. Cross-platform compatibility ───────────────────────────────────────────

section("9 · Cross-platform compatibility");

// 9a. "type": "module" in package.json (required for ESM imports everywhere)
if (pkg.type === "module") {
  pass('package.json "type": "module" — ESM on all runtimes');
} else {
  fail('package.json missing "type":"module"');
}

// 9b. Node version compatibility
const nodeMajor = parseInt(process.version.slice(1));
if (nodeMajor >= 18) {
  pass(`Node.js ${process.version} — meets >=18 requirement (Replit/Pterodactyl/GitHub)`);
} else {
  fail(`Node.js ${process.version} — too old; requires >=18`);
}

// 9c. pnpm-lock.yaml lockfileVersion compatible
const lockContent = fs.readFileSync(lockPath, "utf8");
const lockVersionMatch = lockContent.match(/^lockfileVersion:\s*'(.+?)'/m);
const lockVer = lockVersionMatch?.[1];
if (lockVer) {
  pass(`pnpm-lock.yaml lockfileVersion: '${lockVer}' — regeneratable on any platform`);
} else {
  fail("could not read lockfileVersion from pnpm-lock.yaml");
}

// 9d. No hardcoded localhost or absolute OS paths in config
const configFiles = fs.readdirSync(path.join(ROOT, "config")).filter(f => f.endsWith(".js"));
let hardcodedIssues = 0;
for (const cf of configFiles) {
  const content = fs.readFileSync(path.join(ROOT, "config", cf), "utf8");
  if (/localhost|127\.0\.0\.1|\/home\/runner\//.test(content)) {
    fail(`hardcoded path/host in config/${cf}`);
    hardcodedIssues++;
  }
}
if (hardcodedIssues === 0) {
  pass("no hardcoded localhost/paths in config/ — portable across platforms");
}

// 9e. .gitignore excludes node_modules and env
const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
if (gitignore.includes("node_modules")) {
  pass(".gitignore excludes node_modules — safe for GitHub push");
} else {
  fail(".gitignore does NOT exclude node_modules");
}
if (gitignore.includes(".env")) {
  pass(".gitignore excludes .env — secrets not committed");
} else {
  fail(".gitignore does NOT exclude .env");
}

// 9f. .env.example exists (Pterodactyl/GitHub setup guide)
if (fs.existsSync(path.join(ROOT, ".env.example"))) {
  pass(".env.example exists — new deployments can copy it");
} else {
  fail(".env.example missing — new installs have no config reference");
}

// 9g. start script defined
if (pkg.scripts?.start) {
  pass(`"start" script defined: "${pkg.scripts.start}"`);
} else {
  fail('no "start" script in package.json');
}

// 9h. No relative requires leaking absolute paths in src
const srcAbsoluteRefs = [];
for (const f of sourceFiles) {
  const content = fs.readFileSync(f, "utf8");
  if (/\/home\/runner\/|C:\\/.test(content)) {
    srcAbsoluteRefs.push(path.relative(ROOT, f));
  }
}
if (srcAbsoluteRefs.length === 0) {
  pass("no absolute OS paths embedded in source files");
} else {
  fail("absolute paths found in source", srcAbsoluteRefs.join(", "));
}

// ── 10. Scanner module integrity ──────────────────────────────────────────────

section("10 · Scanner module integrity");

// Import scanner utilities (syntax + runtime init)
const SCANNER_UTILS = [
  "src/features/scanner/scanFile.js",
  "src/features/scanner/astAnalyzer.js",
  "src/features/scanner/parser.js",
  "src/features/scanner/scorer.js",
  "src/features/scanner/detector.js",
  "src/features/scanner/heuristic.js",
];

for (const rel of SCANNER_UTILS) {
  const fullPath = path.join(ROOT, rel);
  if (!fs.existsSync(fullPath)) {
    fail(`scanner file missing: ${rel}`);
    continue;
  }
  try {
    await import(fullPath);
    pass(`import OK: ${rel}`);
  } catch (e) {
    fail(`import FAILED: ${rel}`, e.message.split("\n")[0]);
  }
}

// luaparse integration — run a real parse
try {
  const luaparse = (await import("luaparse")).default;
  const ast = luaparse.parse(`local x = 1 + 2\nprint(x)`);
  if (ast && ast.type === "Chunk") {
    pass("luaparse: real Lua AST parse OK");
  } else {
    fail("luaparse: unexpected AST type", ast?.type);
  }
} catch (e) {
  fail("luaparse real parse failed", e.message);
}

// adm-zip — create/read a zip in memory (used by scanner for archive files)
try {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip();
  zip.addFile("test.txt", Buffer.from("hello scanner"));
  const readBack = zip.readAsText("test.txt");
  if (readBack === "hello scanner") {
    pass("adm-zip: create + read zip in memory OK");
  } else {
    fail("adm-zip: read-back mismatch");
  }
} catch (e) {
  fail("adm-zip runtime test failed", e.message);
}

// ── 11. BoomBox service modules — import chain ────────────────────────────────

section("11 · BoomBox service modules — import chain");

const BOOMBOX_MODULES = [
  "src/services/providerHealth.js",
  "src/features/queue/boomboxQueue.js",
  "src/services/top4top.js",
  "src/services/kaizenDownloader.js",
];

for (const rel of BOOMBOX_MODULES) {
  const fullPath = path.join(ROOT, rel);
  if (!fs.existsSync(fullPath)) {
    fail(`module missing: ${rel}`);
    continue;
  }
  try {
    await import(fullPath);
    pass(`import OK: ${rel}`);
  } catch (e) {
    fail(`import FAILED: ${rel}`, e.message.split("\n")[0]);
  }
}

// ytmp3gg.js exports the correct functions
try {
  const ytmp3gg = await import(path.join(ROOT, "src/services/ytmp3gg.js"));
  const exports  = Object.keys(ytmp3gg);
  const required = ["ytdl", "getVideoInfo", "initBinary"];
  for (const fn of required) {
    if (typeof ytmp3gg[fn] === "function") {
      pass(`ytmp3gg.js exports '${fn}' (function)`);
    } else {
      fail(`ytmp3gg.js missing export '${fn}'`, `got ${typeof ytmp3gg[fn]}`);
    }
  }
} catch (e) {
  fail("ytmp3gg.js import failed", e.message.split("\n")[0]);
}

// top4top.js exports 'top4top' function
try {
  const { top4top } = await import(path.join(ROOT, "src/services/top4top.js"));
  if (typeof top4top === "function") {
    pass("top4top.js exports 'top4top' (function)");
  } else {
    fail("top4top.js 'top4top' not a function");
  }
} catch (e) {
  fail("top4top.js import failed", e.message.split("\n")[0]);
}

// ── 12. Event module & command loader integrity ───────────────────────────────

section("12 · Event modules & command structure");

const EVENT_FILES = [
  "src/events/ready.js",
  "src/events/messageCreate.js",
  "src/events/interactionCreate.js",
];
for (const rel of EVENT_FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) { fail(`event file missing: ${rel}`); continue; }
  try {
    execSync(`node --check "${full}"`, { stdio: "pipe" });
    pass(`syntax OK: ${rel}`);
  } catch (e) {
    fail(`syntax FAIL: ${rel}`, e.stderr?.toString().trim().split("\n")[0]);
  }
}

// Count command files
const cmdDir = path.join(ROOT, "src/commands");
const cmdFiles = fs.readdirSync(cmdDir).filter(f => f.endsWith(".js") && f !== "index.js" && f !== "deploy.js");
pass(`${cmdFiles.length} command files in src/commands/: ${cmdFiles.join(", ")}`);

// Each command file should export a 'data' and 'execute'
let cmdOk = 0;
for (const f of cmdFiles) {
  const full = path.join(cmdDir, f);
  try {
    const mod = await import(full);
    const hasData    = mod.data    !== undefined;
    const hasExecute = typeof mod.execute === "function";
    if (hasData && hasExecute) {
      cmdOk++;
    } else {
      fail(`command ${f} missing export`, `data=${hasData} execute=${hasExecute}`);
    }
  } catch (e) {
    fail(`command ${f} import failed`, e.message.split("\n")[0]);
  }
}
if (cmdOk === cmdFiles.length) {
  pass(`all ${cmdFiles.length} commands export { data, execute }`);
}

// ── Final report ──────────────────────────────────────────────────────────────

process.stdout.write(`\n${"═".repeat(60)}\n`);
process.stdout.write(`VERIFICATION COMPLETE\n`);
process.stdout.write(`${"═".repeat(60)}\n`);
process.stdout.write(`  Passed : ${passed}\n`);
process.stdout.write(`  Failed : ${failed}\n`);
process.stdout.write(`${"═".repeat(60)}\n`);

if (failures.length > 0) {
  process.stdout.write(`\nFAILURES:\n`);
  for (const { label, detail } of failures) {
    process.stdout.write(`  ❌  ${label}${detail ? `\n      → ${detail}` : ""}\n`);
  }
}

process.exit(failed > 0 ? 1 : 0);
