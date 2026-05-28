import { describe, it, expect } from "vitest";
import {
  evaluateRouting,
  parseCondition,
  type RoutingEnv,
  type RoutingRule,
} from "./evaluate";

// ---------------------------------------------------------------------------
// Tests for the routing DSL evaluator (vision §4.4). After a step completes
// and its `output` is merged into the run's `context`, the runner walks the
// step's `routing` rules top-to-bottom against `{ output, context }` and
// returns the first matching rule's `next` (a step id or null).
//
// The DSL grammar is intentionally small: field access (output.x, context.y),
// equality/inequality, boolean/string/numeric literals, &&, ||, !. No `eval`,
// no Function constructor, no sandboxed JS — parsing produces a tiny AST that
// the evaluator walks against the data.
// ---------------------------------------------------------------------------

function env(
  output: Record<string, unknown> = {},
  context: Record<string, unknown> = {},
): RoutingEnv {
  return { output, context };
}

// --- parseCondition: surfaces parse errors at workflow-load time -----------
describe("parseCondition surfaces unknown identifiers as a parse error", () => {
  it("rejects a bare identifier that is not `output`, `context`, `true`, or `false`", () => {
    expect(() => parseCondition("verdict == 'approved'")).toThrow(
      /unknown identifier/i,
    );
  });

  it("rejects a field access whose root is not `output` or `context`", () => {
    expect(() => parseCondition("runMeta.x == 1")).toThrow(
      /unknown identifier/i,
    );
  });
});

describe("parseCondition surfaces syntax errors", () => {
  it("rejects an unterminated string literal", () => {
    expect(() => parseCondition("output.x == 'foo")).toThrow();
  });

  it("rejects an unexpected token", () => {
    expect(() => parseCondition("output.x ==")).toThrow();
  });
});

describe("parseCondition accepts the literal boolean `true` as a catch-all", () => {
  it("returns an ast without throwing", () => {
    expect(() => parseCondition("true")).not.toThrow();
  });
});

// --- evaluateRouting: equality + inequality --------------------------------
describe("Equality operator matches on string output values", () => {
  it("matches the first rule whose condition is satisfied", () => {
    const rules: RoutingRule[] = [
      { condition: "output.verdict == 'approved'", next: "wait_copilot" },
      { condition: "true", next: null },
    ];
    expect(evaluateRouting(rules, env({ verdict: "approved" }))).toBe(
      "wait_copilot",
    );
  });
});

describe("Inequality operator distinguishes from equality", () => {
  it("matches when values differ", () => {
    const rules: RoutingRule[] = [
      { condition: "output.verdict != 'approved'", next: "fix_review" },
      { condition: "true", next: null },
    ];
    expect(evaluateRouting(rules, env({ verdict: "changes_requested" }))).toBe(
      "fix_review",
    );
  });
});

// --- Logical operators -----------------------------------------------------
describe("Logical AND requires both sides", () => {
  it("matches only when both operands evaluate true", () => {
    const rules: RoutingRule[] = [
      {
        condition: "output.verdict == 'approved' && output.ciGreen == true",
        next: "merge",
      },
      { condition: "true", next: null },
    ];
    expect(
      evaluateRouting(rules, env({ verdict: "approved", ciGreen: true })),
    ).toBe("merge");
    expect(
      evaluateRouting(rules, env({ verdict: "approved", ciGreen: false })),
    ).toBeNull();
  });
});

describe("Logical OR matches either side", () => {
  it("matches when the first operand is true", () => {
    const rules: RoutingRule[] = [
      {
        condition:
          "output.verdict == 'approved' || output.verdict == 'auto_approved'",
        next: "merge",
      },
      { condition: "true", next: null },
    ];
    expect(evaluateRouting(rules, env({ verdict: "auto_approved" }))).toBe(
      "merge",
    );
  });
});

describe("Logical NOT inverts truth", () => {
  it("matches when the inner condition is false", () => {
    const rules: RoutingRule[] = [
      { condition: "!(output.verdict == 'approved')", next: "fix_review" },
      { condition: "true", next: null },
    ];
    expect(evaluateRouting(rules, env({ verdict: "blocked" }))).toBe(
      "fix_review",
    );
  });
});

// --- Field access ---------------------------------------------------------
describe("Nested field access reaches deep into context", () => {
  it("resolves a multi-segment path against the context object", () => {
    const rules: RoutingRule[] = [
      {
        condition: "context.lastReview.author == 'copilot'",
        next: "copilot_path",
      },
      { condition: "true", next: null },
    ];
    expect(
      evaluateRouting(rules, env({}, { lastReview: { author: "copilot" } })),
    ).toBe("copilot_path");
  });
});

describe("Missing field paths evaluate to undefined and do not match string literals", () => {
  it("returns the catch-all when a missing field is compared to a string", () => {
    const rules: RoutingRule[] = [
      { condition: "output.missing == 'x'", next: "first" },
      { condition: "true", next: null },
    ];
    expect(evaluateRouting(rules, env({}))).toBeNull();
  });
});

// --- Top-to-bottom precedence ---------------------------------------------
describe("Rules are evaluated top-to-bottom and the first match wins", () => {
  it("does not fall through past a matching rule", () => {
    const rules: RoutingRule[] = [
      { condition: "output.verdict == 'approved'", next: "merge" },
      { condition: "output.verdict == 'approved'", next: "wrong" },
      { condition: "true", next: null },
    ];
    expect(evaluateRouting(rules, env({ verdict: "approved" }))).toBe("merge");
  });
});

// --- Catch-all & no-match error -------------------------------------------
describe("A condition of `true` is the catch-all", () => {
  it("matches when no earlier rule matched", () => {
    const rules: RoutingRule[] = [
      { condition: "output.verdict == 'approved'", next: "merge" },
      { condition: "true", next: "terminal" },
    ];
    expect(evaluateRouting(rules, env({ verdict: "blocked" }))).toBe(
      "terminal",
    );
  });
});

describe("Evaluator throws when no rule matches (no catch-all)", () => {
  it("surfaces the missing-catch-all as a runtime error", () => {
    const rules: RoutingRule[] = [
      { condition: "output.verdict == 'approved'", next: "merge" },
    ];
    expect(() => evaluateRouting(rules, env({ verdict: "blocked" }))).toThrow(
      /no routing rule matched/i,
    );
  });
});

// --- Numeric literal support (acceptance grammar) -------------------------
describe("Numeric literals support equality comparisons", () => {
  it("matches when an output number equals a literal number", () => {
    const rules: RoutingRule[] = [
      { condition: "output.retryCount == 0", next: "first_try" },
      { condition: "true", next: null },
    ];
    expect(evaluateRouting(rules, env({ retryCount: 0 }))).toBe("first_try");
  });
});
