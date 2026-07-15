// Call-graph / control-flow-level structural analysis, on top of the real
// luaparse AST (never regex over text). Complements astAnalyzer.js (which
// looks at nesting/recursion/dispatch shape) with three specific, honestly-
// gated signals the spec calls out by name:
//
//   1. Call graph -- which named globals/functions get called, and whether
//      any call target is one of Lua's dynamic-code-execution primitives
//      (load/loadstring/dofile/loadfile/setfenv/getfenv).
//   2. Dynamic code construction -- a call to one of those primitives whose
//      argument is NOT a plain string literal (i.e. it's built at runtime
//      via concatenation, a function call, or a variable) -- the classic
//      "build a string then execute it" loader shape.
//   3. Dead/unreachable code -- statements that appear after an
//      unconditional `return`/`break` in the same block. Reported as a
//      low-weight, informational-leaning signal: on its own it is common in
///     generated/minified code and not a strong indicator, but combined
//      with other findings it supports the "junk code inserted by an
//      obfuscator" story.
//
// Every signal only fires on a genuine AST shape match -- nothing is
// inferred from identifier names, which obfuscators routinely randomize.

const DYNAMIC_EXEC_NAMES = new Set(["load", "loadstring", "dofile", "loadfile", "setfenv", "getfenv"]);

const MAX_NODES = 200_000;

function walk(node, visit, budget) {
  if (!node || typeof node !== "object" || budget.count > MAX_NODES) return;
  budget.count += 1;
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "range" || key === "loc") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit, budget);
    } else if (child && typeof child === "object") {
      walk(child, visit, budget);
    }
  }
}

function calleeName(base) {
  if (!base) return null;
  if (base.type === "Identifier") return base.name;
  if (base.type === "MemberExpression" && base.identifier) return base.identifier.name;
  return null;
}

// Is this argument expression a "just a string, nothing dynamic" literal?
// Anything else (concatenation, call, identifier, table lookup) counts as
// dynamically constructed for the purposes of this signal.
function isPlainStringLiteral(node) {
  return !!node && node.type === "StringLiteral";
}

function isTrueLiteral(node) {
  return !!node && node.type === "BooleanLiteral" && node.value === true;
}

// Lua's grammar requires `return`/`break` to already be the last statement
// of their own block -- a well-formed AST can never have trailing
// statements after one, so checking for that shape is dead code itself.
// The one AST shape that *does* produce genuinely unreachable trailing
// statements is a `while true do ... end` loop with no `break` anywhere
// inside it: nothing after that loop, in the same body, can ever run.
function hasBreakInside(node, budget) {
  let found = false;
  walk(node, (inner) => {
    if (inner.type === "BreakStatement") found = true;
  }, budget);
  return found;
}

/**
 * @param {import("luaparse").Chunk} ast
 * @returns {{
 *   callCounts: Record<string, number>,
 *   dynamicExecCalls: Array<{ name:string, dynamicArgument:boolean }>,
 *   deadCodeBlockCount: number,
 * }}
 */
export function analyzeCallGraph(ast) {
  const result = { callCounts: {}, dynamicExecCalls: [], deadCodeBlockCount: 0 };
  if (!ast) return result;

  const budget = { count: 0 };

  walk(ast, (node) => {
    if (node.type === "CallExpression" || node.type === "StringCallExpression") {
      const name = calleeName(node.base);
      if (name) {
        result.callCounts[name] = (result.callCounts[name] || 0) + 1;
        if (DYNAMIC_EXEC_NAMES.has(name)) {
          const arg = node.arguments && node.arguments[0];
          result.dynamicExecCalls.push({
            name,
            dynamicArgument: node.type === "CallExpression" ? !isPlainStringLiteral(arg) : false,
          });
        }
      }
    }

    // Dead/unreachable code: a `while true do ... end` loop with no
    // `break` anywhere inside it, followed by more statements in the same
    // block -- those trailing statements can never execute.
    if (Array.isArray(node.body)) {
      const idx = node.body.findIndex(
        (s) => s && s.type === "WhileStatement" && isTrueLiteral(s.condition) && !hasBreakInside(s, budget),
      );
      if (idx !== -1 && idx < node.body.length - 1) {
        result.deadCodeBlockCount += 1;
      }
    }
  }, budget);

  return result;
}

/**
 * Convert call-graph stats into indicator-shaped entries (same shape as
 * heuristic/indicators.js) for the existing scoring/report pipeline.
 * Thresholds: a single dynamic-exec call with a literal argument (e.g.
 * `dofile("config.lua")`) is completely normal Lua and not flagged; only a
 * dynamically-built argument to load/loadstring/dofile/loadfile (the
 * "build a string then execute it" loader shape) is treated as suspicious.
 */
export function callGraphStatsToIndicators(stats) {
  const indicators = [];
  if (!stats) return indicators;

  const dynamicBuilt = stats.dynamicExecCalls.filter((c) => c.dynamicArgument);
  if (dynamicBuilt.length > 0) {
    const names = Array.from(new Set(dynamicBuilt.map((c) => c.name))).join(", ");
    indicators.push({
      id: "dynamicCodeConstruction",
      label: `Dynamic Code Construction (${names} dipanggil dengan argumen yang dibangun saat runtime, bukan literal string)`,
      severity: "high",
      weight: 18,
      group: "execution",
      count: dynamicBuilt.length,
      samples: [],
    });
  } else if (stats.dynamicExecCalls.length > 0) {
    // Still worth surfacing informationally -- calling load/loadstring at
    // all is unusual outside of a loader/plugin system, even with a
    // literal argument, but it's far weaker evidence than the dynamic case
    // above so it gets a much smaller weight and no "info-only" downgrade.
    const names = Array.from(new Set(stats.dynamicExecCalls.map((c) => c.name))).join(", ");
    indicators.push({
      id: "dynamicExecUsage",
      label: `Penggunaan fungsi eksekusi dinamis (${names})`,
      severity: "medium",
      weight: 6,
      group: "execution",
      count: stats.dynamicExecCalls.length,
      samples: [],
    });
  }

  if (stats.deadCodeBlockCount >= 2) {
    indicators.push({
      id: "deadCodeBlocks",
      label: `Dead/unreachable code terdeteksi via AST (${stats.deadCodeBlockCount} blok berisi kode setelah return/break)`,
      severity: "low",
      weight: 4,
      group: "obfuscation",
      count: stats.deadCodeBlockCount,
      samples: [],
    });
  }

  return indicators;
}
