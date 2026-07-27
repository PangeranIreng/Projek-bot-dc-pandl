/**
 * Lightweight, local project knowledge. It stores metadata, not source code,
 * so routine questions can search the project without sending the whole repo
 * to a provider.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiCoreDB } from "../../database/aiCoreDB.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", ".local", ".agents", "storage", "logs", "data", "bin", "attached_assets", "artifacts"]);
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".toml", ".yaml", ".yml"]);
const MAX_INDEX_FILE_BYTES = 512 * 1024;

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

function extractMetadata(text) {
  const functions = [];
  const functionPattern = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  for (const match of text.matchAll(functionPattern)) {
    const name = match[1] || match[2];
    if (name && !functions.includes(name)) functions.push(name);
  }
  const imports = [...text.matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)]
    .map((match) => match[1] || match[2])
    .slice(0, 30);
  const exports = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1])
    .slice(0, 30);
  return { functions, imports, exports };
}

export function rebuildProjectIndex() {
  const files = collectFiles(ROOT).map((file) => {
    const rel = relative(file);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { path: rel, size: 0, lines: 0, functions: [], imports: [], exports: [], skipped: "unreadable" };
    }
    if (size > MAX_INDEX_FILE_BYTES) {
      return {
        path: rel,
        size,
        lines: 0,
        functions: [],
        imports: [],
        exports: [],
        skipped: `over ${MAX_INDEX_FILE_BYTES} bytes`,
      };
    }
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return { path: rel, size, lines: 0, functions: [], imports: [], exports: [], skipped: "unreadable" };
    }
    const metadata = extractMetadata(text);
    return {
      path: rel,
      size,
      lines: text.split("\n").length,
      ...metadata,
    };
  });

  const byDirectory = {};
  for (const file of files) {
    const top = file.path.split("/")[0] || "root";
    byDirectory[top] = (byDirectory[top] ?? 0) + 1;
  }

  const knowledge = {
    builtAt: new Date().toISOString(),
    summary: {
      fileCount: files.length,
      functionCount: files.reduce((sum, file) => sum + file.functions.length, 0),
      directoryCounts: byDirectory,
      dependencies: readDependencies(),
    },
    files,
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

export function getProjectKnowledge() {
  const current = aiCoreDB.getKnowledge();
  return current.builtAt && current.files.length ? current : rebuildProjectIndex();
}

export function searchProject(query, limit = 8) {
  const knowledge = getProjectKnowledge();
  const terms = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_$.-]+/)
    .filter((term) => term.length >= 2)
    .slice(0, 12);
  const ranked = knowledge.files
    .map((file) => {
      const haystack = `${file.path} ${file.functions.join(" ")} ${file.imports.join(" ")}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { file, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .slice(0, limit);

  return ranked.map(({ file, score }) => {
    const full = path.join(ROOT, file.path);
    let excerpt = "";
    try {
      const text = fs.readFileSync(full, "utf8");
      const lines = text.split("\n");
      const matchingLine = lines.findIndex((line) => terms.some((term) => line.toLowerCase().includes(term)));
      const start = Math.max(0, matchingLine < 0 ? 0 : matchingLine - 12);
      excerpt = lines.slice(start, start + 55).join("\n").slice(0, 5200);
    } catch {
      excerpt = "[File could not be read]";
    }
    return { ...file, score, excerpt };
  });
}

export function getProjectRoot() {
  return ROOT;
}