/**
 * Lightweight, local project knowledge. Stores rich metadata and excerpts —
 * not full source — so routine questions can search the project without
 * sending the whole repo to a provider.
 *
 * Improvements over v1:
 *  - extractMetadata() now captures class names, event listeners, Discord
 *    command names, interaction customId patterns, and re-exported symbols.
 *  - searchProject() scores on exports, classes, events, commands, customIds
 *    in addition to path, functions, and imports.
 *  - Dependency graph (reverse import map) is built and saved with knowledge.
 *  - shouldRebuildIndex() returns true when the index is older than TTL or
 *    when key source files have changed since the last build.
 *  - getProjectKnowledge() rebuilds automatically when the index is stale.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiCoreDB } from "../../database/aiCoreDB.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", ".local", ".agents",
  "storage", "logs", "data", "bin", "attached_assets", "artifacts",
]);
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".toml", ".yaml", ".yml"]);
const MAX_INDEX_FILE_BYTES = 512 * 1024;

/** How long (ms) before the index is considered stale and auto-rebuilt. */
const INDEX_TTL_MS = 60 * 60 * 1000; // 1 hour

function relative(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, "/");
}

function collectFiles(dir, result = []) {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, result);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) || entry.name === "package.json") {
      result.push(full);
    }
  }
  return result;
}

/**
 * Extract rich metadata from source text.
 * Returns: functions, classes, methods, constants, events, commands, customIds,
 *          imports, exports, todos.
 */
function extractMetadata(text) {
  const functions = [];
  const classes   = [];
  const methods   = [];
  const constants = [];
  const events    = [];
  const commands  = [];
  const customIds = [];
  const todos     = [];

  // Named function declarations + arrow functions / regular functions assigned to const/let/var
  const functionPattern =
    /(?:^|[\s;,{(])(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm;
  for (const match of text.matchAll(functionPattern)) {
    const name = match[1] || match[2];
    if (name && !functions.includes(name)) functions.push(name);
  }

  // Class declarations: class Foo { ... }
  for (const match of text.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) {
    if (!classes.includes(match[1])) classes.push(match[1]);
  }

  // Class methods: detect lines like `  methodName(` or `  async methodName(` inside class bodies
  // Pattern: 2–8 spaces indent + optional modifiers + identifier + (
  for (const match of text.matchAll(
    /^[ \t]{2,8}(?:(?:static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\(/gm,
  )) {
    const name = match[1];
    // Exclude constructor, common reserved keywords
    if (name && name !== "constructor" && name !== "if" && name !== "for" &&
        name !== "while" && name !== "switch" && name !== "return" &&
        !methods.includes(name)) {
      methods.push(name);
    }
  }

  // Named constants: ALL_CAPS or UPPER_First exported/top-level const/let/var
  // We capture: export const FOO, const MAX_RETRY, let DEFAULT_TIMEOUT
  for (const match of text.matchAll(
    /(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_$]{2,})\s*=/gm,
  )) {
    if (!constants.includes(match[1])) constants.push(match[1]);
  }

  // Event listeners: client.on('ready'), .on("messageCreate"), emitter.once("event")
  for (const match of text.matchAll(/\.(?:on|once|emit)\s*\(\s*["']([^"']+)["']/g)) {
    if (!events.includes(match[1])) events.push(match[1]);
  }

  // Discord slash command / sub-command names:
  //   name: "command"  |  commandName: "cmd"  |  .setName("cmd")
  for (const match of text.matchAll(
    /(?:\bname\s*:\s*|commandName\s*:\s*|\.setName\s*\(\s*)["']([a-z0-9_-]{1,32})["']/gi,
  )) {
    const n = match[1].toLowerCase();
    if (!commands.includes(n)) commands.push(n);
  }

  // Discord customId strings:
  //   customId: "prefix:action"  |  .setCustomId("id")  |  customId(`prefix:${var}`)
  for (const match of text.matchAll(
    /(?:customId\s*:\s*|\.setCustomId\s*\(\s*)["'`]([^"'`\n]+)["'`]/g,
  )) {
    const raw = match[1].replace(/\$\{[^}]*\}/g, "*"); // normalise template vars
    if (!customIds.includes(raw)) customIds.push(raw);
  }

  // TODO / FIXME / DEPRECATED / HACK / NOTE annotations
  for (const match of text.matchAll(
    /\/\/\s*(TODO|FIXME|DEPRECATED|HACK|NOTE|XXX)\s*[:\-]?\s*(.{0,80})/gi,
  )) {
    const tag  = match[1].toUpperCase();
    const note = match[2].trim().slice(0, 60);
    const entry = note ? `${tag}: ${note}` : tag;
    if (!todos.includes(entry)) todos.push(entry);
  }

  // Imports: from "..." or import "..."
  const imports = [...text.matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)]
    .map((m) => m[1] || m[2])
    .filter(Boolean)
    .slice(0, 30);

  // Exports: export function/class/const/let/var + re-export { ... } from
  const exportedNames = new Set();
  for (const m of text.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    exportedNames.add(m[1]);
  }
  // Named re-exports: export { foo, bar as baz } from '...'
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/\s+as\s+\S+$/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exportedNames.add(name);
    }
  }
  const exports = [...exportedNames].slice(0, 40);

  return { functions, classes, methods, constants, events, commands, customIds, imports, exports, todos };
}

/**
 * Build a reverse-import map: for each import specifier, which files import it.
 * Only relative imports (starting with ".") are tracked — npm packages are skipped.
 * Stored in knowledge.dependencyGraph as { [specifier]: [importerRelPath, ...] }.
 */
function buildDependencyGraph(indexedFiles) {
  /** @type {Record<string, string[]>} */
  const graph = {};
  for (const file of indexedFiles) {
    for (const imp of file.imports) {
      if (!imp.startsWith(".")) continue;
      if (!graph[imp]) graph[imp] = [];
      graph[imp].push(file.path);
    }
  }
  return graph;
}

// ── Public API ──────────────────────────────────────────────────────────────────

export function rebuildProjectIndex() {
  const allFiles = collectFiles(ROOT);
  const indexed  = allFiles.map((file) => {
    const rel = relative(file);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { path: rel, size: 0, lines: 0, functions: [], classes: [], events: [], commands: [], customIds: [], imports: [], exports: [], skipped: "unreadable" };
    }
    if (size > MAX_INDEX_FILE_BYTES) {
      return {
        path: rel, size, lines: 0,
        functions: [], classes: [], events: [], commands: [], customIds: [],
        imports: [], exports: [],
        skipped: `over ${MAX_INDEX_FILE_BYTES} bytes`,
      };
    }
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return { path: rel, size, lines: 0, functions: [], classes: [], methods: [], constants: [], events: [], commands: [], customIds: [], imports: [], exports: [], todos: [], skipped: "unreadable" };
    }
    const metadata = extractMetadata(text);
    return {
      path:  rel,
      size,
      lines: text.split("\n").length,
      ...metadata,
    };
  });

  const byDirectory = {};
  for (const file of indexed) {
    const top = file.path.split("/")[0] || "root";
    byDirectory[top] = (byDirectory[top] ?? 0) + 1;
  }

  // Collect all TODOs/FIXMEs across the project for global visibility
  const allTodos = indexed
    .filter((f) => f.todos?.length)
    .map((f) => f.todos.map((t) => `${f.path}: ${t}`))
    .flat()
    .slice(0, 100);

  const knowledge = {
    builtAt: new Date().toISOString(),
    summary: {
      fileCount:       indexed.length,
      functionCount:   indexed.reduce((s, f) => s + f.functions.length, 0),
      classCount:      indexed.reduce((s, f) => s + (f.classes?.length ?? 0), 0),
      methodCount:     indexed.reduce((s, f) => s + (f.methods?.length ?? 0), 0),
      constantCount:   indexed.reduce((s, f) => s + (f.constants?.length ?? 0), 0),
      eventCount:      indexed.reduce((s, f) => s + (f.events?.length ?? 0), 0),
      commandCount:    indexed.reduce((s, f) => s + (f.commands?.length ?? 0), 0),
      todoCount:       allTodos.length,
      directoryCounts: byDirectory,
      dependencies:    readDependencies(),
      todos:           allTodos,
    },
    dependencyGraph: buildDependencyGraph(indexed),
    files: indexed,
  };

  aiCoreDB.saveKnowledge(knowledge);
  return knowledge;
}

function readDependencies() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return Object.keys(pkg.dependencies ?? {}).sort();
  } catch {
    return [];
  }
}

/**
 * Returns true when the stored index is missing, empty, or older than INDEX_TTL_MS.
 * Also returns true when the index was built before the package.json was last modified
 * (which catches dependency changes but not individual source edits — use the TTL for those).
 */
export function shouldRebuildIndex() {
  const k = aiCoreDB.getKnowledge();
  if (!k.builtAt || !k.files.length) return true;
  const age = Date.now() - new Date(k.builtAt).getTime();
  if (age > INDEX_TTL_MS) return true;
  // If package.json changed after the last build, rebuild
  try {
    const pkgMtime = fs.statSync(path.join(ROOT, "package.json")).mtimeMs;
    if (pkgMtime > new Date(k.builtAt).getTime()) return true;
  } catch { /* ignore */ }
  return false;
}

export function getProjectKnowledge() {
  if (shouldRebuildIndex()) {
    try {
      return rebuildProjectIndex();
    } catch { /* fall through to stale cache */ }
  }
  const current = aiCoreDB.getKnowledge();
  return current.builtAt && current.files.length ? current : rebuildProjectIndex();
}

/**
 * Search the project index for files relevant to a query.
 * Scoring: each search term earns points based on where it matches.
 *   +3  exact term in file path
 *   +2  term in exports, classes, commands, customIds
 *   +1  term in functions or imports
 */
export function searchProject(query, limit = 8) {
  const knowledge = getProjectKnowledge();
  const terms = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_$.:/-]+/)
    .filter((term) => term.length >= 2)
    .slice(0, 16);

  if (!terms.length) return [];

  const ranked = knowledge.files
    .map((file) => {
      const pathLower    = file.path.toLowerCase();
      const fnLower      = (file.functions ?? []).join(" ").toLowerCase();
      const clsLower     = (file.classes   ?? []).join(" ").toLowerCase();
      const mtdLower     = (file.methods   ?? []).join(" ").toLowerCase();
      const cstLower     = (file.constants ?? []).join(" ").toLowerCase();
      const evtLower     = (file.events    ?? []).join(" ").toLowerCase();
      const cmdLower     = (file.commands  ?? []).join(" ").toLowerCase();
      const cuidLower    = (file.customIds ?? []).join(" ").toLowerCase();
      const expLower     = (file.exports   ?? []).join(" ").toLowerCase();
      const impLower     = (file.imports   ?? []).join(" ").toLowerCase();
      const todoLower    = (file.todos     ?? []).join(" ").toLowerCase();

      let score = 0;
      for (const term of terms) {
        if (pathLower.includes(term))  score += 3;
        if (expLower.includes(term))   score += 2;
        if (clsLower.includes(term))   score += 2;
        if (cmdLower.includes(term))   score += 2;
        if (cuidLower.includes(term))  score += 2;
        if (cstLower.includes(term))   score += 2;
        if (mtdLower.includes(term))   score += 1;
        if (evtLower.includes(term))   score += 1;
        if (fnLower.includes(term))    score += 1;
        if (impLower.includes(term))   score += 1;
        if (todoLower.includes(term))  score += 1;
      }
      return { file, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .slice(0, limit);

  return ranked.map(({ file, score }) => {
    const full = path.join(ROOT, file.path);
    let excerpt = "";
    try {
      const text  = fs.readFileSync(full, "utf8");
      const lines = text.split("\n");
      // Find the first line containing any search term to anchor the excerpt
      const matchingLine = lines.findIndex((line) =>
        terms.some((term) => line.toLowerCase().includes(term)),
      );
      const start = Math.max(0, matchingLine < 0 ? 0 : matchingLine - 10);
      excerpt = lines.slice(start, start + 60).join("\n").slice(0, 5500);
    } catch {
      excerpt = "[File could not be read]";
    }
    return { ...file, score, excerpt };
  });
}

export function getProjectRoot() {
  return ROOT;
}
