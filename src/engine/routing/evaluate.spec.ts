import { describe, it, expect, vi } from "vitest";
import {
  evaluateRouting,
  parseCondition,
  type RoutingEnv,
  type RoutingRule,
} from "./evaluate";
import * as parser from "./parser";

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

  it("rejects a malformed numeric literal with more than one decimal point", () => {
    // Without an explicit shape check the tokenizer would slurp `1.2.3`
    // into a single num token; Number("1.2.3") is NaN, which silently
    // compares unequal to every concrete value at runtime. We want this
    // surfaced at parse time alongside other syntax errors.
    expect(() => parseCondition("output.x == 1.2.3")).toThrow(
      /malformed numeric literal/i,
    );
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

// --- AST caching: parseCondition is memoized ------------------------------
describe("evaluateRouting memoizes parsed conditions across evaluations", () => {
  it("parses each unique condition string exactly once across repeated evaluations", () => {
    const spy = vi.spyOn(parser, "parseCondition");
    // Use unique conditions per test run so we can attribute spy calls
    // to this evaluation independently of other tests that share the
    // module-level cache.
    const uniqueCond = `output.verdict == 'cache-test-${Math.random()}'`;
    const rules: RoutingRule[] = [
      { condition: uniqueCond, next: "next-step" },
      { condition: "true", next: null },
    ];
    const e = env({ verdict: "anything-else" });
    evaluateRouting(rules, e);
    const callsAfterFirst = spy.mock.calls.length;
    evaluateRouting(rules, e);
    evaluateRouting(rules, e);
    // After the first call primed the cache, subsequent evaluations
    // must not re-invoke parseCondition for the same source strings.
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
    spy.mockRestore();
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
