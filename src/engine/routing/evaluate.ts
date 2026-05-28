import { parseCondition, type ConditionAst } from "./parser";

// ---------------------------------------------------------------------------
// Routing DSL evaluator (vision §4.4).
//
// `evaluateRouting(rules, env)` walks the rules top-to-bottom, parses each
// condition into an AST (via `parseCondition`), and returns the first
// matching rule's `next` step id (or `null` for a terminal). If no rule
// matches, it throws — every well-formed workflow ends with a
// `condition: "true"` catch-all, and a missing catch-all is a workflow-
// author bug worth surfacing eagerly.
//
// The condition AST is walked by `evalAst`; field paths resolve to
// `undefined` when any segment is missing (no exceptions for missing
// fields — they simply compare unequal to any concrete value). Equality
// is JavaScript `===` semantics on resolved values; `&&` / `||` are
// short-circuiting in the standard way.
//
// `parseCondition` is re-exported so the workflow loader (separate
// sub-issue) can pre-validate every routing rule at load time and surface
// parse errors (including unknown identifiers) up front rather than at
// run time.
// ---------------------------------------------------------------------------

export { parseCondition } from "./parser";
export type { ConditionAst } from "./parser";

export interface RoutingRule {
  // Condition string in the DSL grammar (see parser.ts header). The
  // YAML literal `true` for catch-all rules is expected to be normalized
  // to the string `"true"` by the workflow loader before reaching this
  // evaluator.
  condition: string;
  // Target step-definition id, or `null` for terminal (run completes).
  next: string | null;
}

export interface RoutingEnv {
  // Merged step output for the just-completed step.
  output: Record<string, unknown>;
  // Run-level context accumulated from all prior step outputs.
  context: Record<string, unknown>;
}

export function evaluateRouting(
  rules: RoutingRule[],
  env: RoutingEnv,
): string | null {
  for (const rule of rules) {
    const ast = parseCondition(rule.condition);
    if (toBool(evalAst(ast, env))) {
      return rule.next;
    }
  }
  throw new Error(
    "No routing rule matched and no `condition: true` catch-all was provided. " +
      "Every workflow must end with a catch-all rule.",
  );
}

function evalAst(ast: ConditionAst, env: RoutingEnv): unknown {
  switch (ast.kind) {
    case "bool":
      return ast.value;
    case "num":
      return ast.value;
    case "str":
      return ast.value;
    case "field":
      return resolvePath(env[ast.root], ast.path);
    case "not":
      return !toBool(evalAst(ast.expr, env));
    case "binary":
      return evalBinary(ast, env);
  }
}

function evalBinary(
  ast: Extract<ConditionAst, { kind: "binary" }>,
  env: RoutingEnv,
): unknown {
  if (ast.op === "&&") {
    const left = toBool(evalAst(ast.left, env));
    if (!left) return false;
    return toBool(evalAst(ast.right, env));
  }
  if (ast.op === "||") {
    const left = toBool(evalAst(ast.left, env));
    if (left) return true;
    return toBool(evalAst(ast.right, env));
  }
  // Equality / inequality. Use strict equality on resolved values; that
  // is the most predictable behaviour for workflow authors and matches
  // their mental model of YAML literals against typed step output.
  const lhs = evalAst(ast.left, env);
  const rhs = evalAst(ast.right, env);
  return ast.op === "==" ? lhs === rhs : lhs !== rhs;
}

function resolvePath(
  root: Record<string, unknown> | undefined,
  path: string[],
): unknown {
  let cur: unknown = root;
  for (const segment of path) {
    if (cur === undefined || cur === null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function toBool(value: unknown): boolean {
  // Strict boolean coercion: only `true` is truthy. This is intentionally
  // stricter than JavaScript's default — workflow authors expect
  // `output.verdict == 'approved'` to evaluate to a definite boolean,
  // not to lean on JS's `1`/`""`/`null` truthiness rules. Non-boolean
  // intermediate values (e.g. an unresolved field path) are treated as
  // false so a missing key never sneaks through as a match.
  return value === true;
}
