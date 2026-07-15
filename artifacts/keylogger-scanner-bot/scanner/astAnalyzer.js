// Structural AST analysis. Walks the real luaparse AST (never regex over
// text) to compute a small set of honest, generic structural signals:
// function nesting depth, self-recursion, "state dispatcher" loops (the
// control-flow-flattening shape: `while true do ... if state==n then ...`),
// and deep _G/_ENV index chains. Every signal here is counted from actual
// AST nodes -- nothing is guessed from node *names* (which obfuscators
// randomize), only from the *shape* of the tree, so this still works when
// every identifier has been renamed.
//
// This module never throws: a malformed/foreign AST just yields zero
// signals rather than crashing the caller.

const MAX_NODES = 200_000; // safety bound for pathological/huge trees

/**
 * Generic recursive walker over any luaparse-shaped node tree. Calls
 * `visit(node, depth)` for every object that looks like an AST node
 * (has a string `type` field). Order/shape agnostic on purpose -- we don't
 * depend on knowing every luaparse node's exact child property names.
 */
function walk(node, depth, visit, budget) {
  if (!node || typeof node !== "object" || budget.count > MAX_NODES) return;
  budget.count += 1;

  if (typeof node.type === "string") {
    visit(node, depth);
  }

  for (const key of Object.keys(node)) {
    if (key === "type" || key === "range" || key === "loc") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, depth, visit, budget);
    } else if (child && typeof child === "object") {
      walk(child, depth, visit, budget);
    }
  }
}

function isTrueLiteral(node) {
  return !!node && node.type === "BooleanLiteral" && node.value === true;
}

// Does this If/Elseif chain look like a `state == N` (or `state == "N"`)
// dispatcher -- the hallmark of a flattened control-flow VM loop?
function looksLikeStateDispatch(ifNode) {
  const clauses = ifNode.clauses || [];
  if (clauses.length < 3) return false; // need real elseif fan-out
  let stateComparisons = 0;
  for (const clause of clauses) {
    const cond = clause.condition;
    if (
      cond &&
      cond.type === "BinaryExpression" &&
      (cond.operator === "==" || cond.operator === "~=")
    ) {
      const other = cond.left?.type === "Identifier" ? cond.right : cond.left;
      if (other && (other.type === "NumericLiteral" || other.type === "StringLiteral")) {
        stateComparisons += 1;
      }
    }
  }
  return stateComparisons >= 3;
}

function collectFunctionName(fnNode) {
  const id = fnNode.identifier;
  if (!id) return null;
  if (id.type === "Identifier") return id.name;
  if (id.type === "MemberExpression" && id.identifier) return id.identifier.name;
  return null;
}

/**
 * @param {import("luaparse").Chunk} ast a successfully parsed luaparse AST
 * @returns {{
 *   functionCount:number,
 *   maxFunctionDepth:number,
 *   recursiveFunctionCount:number,
 *   stateDispatchLoopCount:number,
 *   deepGlobalIndexCount:number,
 *   totalNodeCount:number,
 * }}
 */
export function analyzeAstStructure(ast) {
  const stats = {
    functionCount: 0,
    maxFunctionDepth: 0,
    recursiveFunctionCount: 0,
    stateDispatchLoopCount: 0,
    deepGlobalIndexCount: 0,
    totalNodeCount: 0,
  };
  if (!ast) return stats;

  const budget = { count: 0 };
  let currentFunctionDepth = 0;

  // Recursion detection needs a stack of "which function am I inside, and
  // what's its own name" so a call to that same name counts as recursion.
  const functionNameStack = [];

  walk(ast, 0, (node) => {
    if (node.type === "FunctionDeclaration") {
      stats.functionCount += 1;
      currentFunctionDepth += 1;
      stats.maxFunctionDepth = Math.max(stats.maxFunctionDepth, currentFunctionDepth);
      functionNameStack.push(collectFunctionName(node));
      // Walk the function body with its own sub-budget so we can pop the
      // depth/name stack correctly once this subtree is done. We do this by
      // recursing manually here instead of relying on the generic walker's
      // flat traversal (which has no notion of "leaving" a node).
      for (const stmt of node.body || []) {
        walk(stmt, currentFunctionDepth, (inner) => {
          if (
            inner.type === "CallExpression" &&
            inner.base?.type === "Identifier" &&
            functionNameStack.includes(inner.base.name)
          ) {
            stats.recursiveFunctionCount += 1;
          }
        }, budget);
      }
      currentFunctionDepth -= 1;
      functionNameStack.pop();
      return;
    }

    if (node.type === "WhileStatement" && isTrueLiteral(node.condition)) {
      let found = false;
      walk(node, 0, (inner) => {
        if (!found && inner.type === "IfStatement" && looksLikeStateDispatch(inner)) {
          found = true;
        }
      }, budget);
      if (found) stats.stateDispatchLoopCount += 1;
    }

    if (node.type === "IndexExpression") {
      // Count nesting depth of chained index expressions rooted at _G/_ENV,
      // e.g. _G["a"]["b"] -- depth 2+ is the "globals lookup" indirection
      // technique regardless of what the actual keys are.
      let depth = 0;
      let cursor = node;
      while (cursor && cursor.type === "IndexExpression") {
        depth += 1;
        cursor = cursor.base;
      }
      if (cursor && cursor.type === "Identifier" && (cursor.name === "_G" || cursor.name === "_ENV") && depth >= 2) {
        stats.deepGlobalIndexCount += 1;
      }
    }
  }, budget);

  stats.totalNodeCount = budget.count;
  return stats;
}

/**
 * Turn the raw structural stats into honest, weighted indicator-shaped
 * entries (same shape as heuristic/indicators.js) so they flow through the
 * existing scoring/report pipeline unchanged. Thresholds require multiple
 * occurrences -- one recursive function or one _G[...][...] access is
 * normal code, not obfuscation.
 */
export function astStatsToIndicators(stats) {
  const indicators = [];
  if (!stats) return indicators;

  if (stats.maxFunctionDepth >= 5) {
    indicators.push({
      id: "deepFunctionNesting",
      label: `Nested function berlebihan (kedalaman ${stats.maxFunctionDepth} via AST)`,
      severity: "medium",
      weight: 10,
      group: "obfuscation",
      count: 1,
      samples: [],
    });
  }
  if (stats.recursiveFunctionCount >= 2) {
    indicators.push({
      id: "astRecursionAbuse",
      label: `Rekursi mencurigakan (${stats.recursiveFunctionCount} pemanggilan diri via AST)`,
      severity: "medium",
      weight: 8,
      group: "execution",
      count: stats.recursiveFunctionCount,
      samples: [],
    });
  }
  if (stats.stateDispatchLoopCount >= 1) {
    indicators.push({
      id: "astControlFlowFlattening",
      label: `Control Flow Flattening terkonfirmasi via AST (${stats.stateDispatchLoopCount} state-dispatch loop)`,
      severity: "high",
      weight: 15,
      group: "obfuscation",
      count: stats.stateDispatchLoopCount,
      samples: [],
    });
  }
  if (stats.deepGlobalIndexCount >= 1) {
    indicators.push({
      id: "astGlobalsLookup",
      label: `Globals Lookup terkonfirmasi via AST (${stats.deepGlobalIndexCount} akses _G/_ENV berlapis)`,
      severity: "medium",
      weight: 8,
      group: "obfuscation",
      count: stats.deepGlobalIndexCount,
      samples: [],
    });
  }
  return indicators;
}

// AST complexity is high when the tree has many nodes relative to how much
// of that structure is genuine functions -- a huge flat node count with few
// real functions is typical of flattened/unrolled obfuscated output. Used
// as the (previously unused) `astComplexity` obfuscation signal in
// riskScore.js.
export function isAstComplex(stats) {
  if (!stats || stats.totalNodeCount === 0) return false;
  return (
    stats.totalNodeCount > 4000 ||
    stats.maxFunctionDepth >= 6 ||
    stats.stateDispatchLoopCount >= 1
  );
}
