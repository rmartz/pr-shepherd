import { describe, expect, it } from "vitest";
import { matchWorkflowId } from "./match";

// ---------------------------------------------------------------------------
// Tests for `matchWorkflowId` — the workflowMap resolver (vision §9, #126).
// `match` patterns are evaluated in order; the first match wins; an author
// matching none yields `undefined` (the caller skips that PR).
// ---------------------------------------------------------------------------

describe("match patterns are evaluated in order; first match wins", () => {
  it("returns the workflowId of the first matching entry", () => {
    const workflows = [
      { match: "dependabot[bot]", workflowId: "dependabot-pr" },
      { match: "*", workflowId: "base-pr" },
    ];

    expect(matchWorkflowId("dependabot[bot]", workflows)).toBe("dependabot-pr");
  });

  it("prefers an earlier entry over a later one that also matches", () => {
    const workflows = [
      { match: "octocat", workflowId: "trusted-pr" },
      { match: "*", workflowId: "base-pr" },
    ];

    expect(matchWorkflowId("octocat", workflows)).toBe("trusted-pr");
  });

  it("falls through to the `*` catch-all when no exact entry matches", () => {
    const workflows = [
      { match: "dependabot[bot]", workflowId: "dependabot-pr" },
      { match: "*", workflowId: "base-pr" },
    ];

    expect(matchWorkflowId("octocat", workflows)).toBe("base-pr");
  });

  it("matches the bot login's brackets literally, not as a character class", () => {
    const workflows = [
      { match: "dependabot[bot]", workflowId: "dependabot-pr" },
    ];

    // A regex character class would let "dependabotb" match; literal matching
    // must not.
    expect(matchWorkflowId("dependabotb", workflows)).toBeUndefined();
  });
});

describe("a PR matching no entry is skipped", () => {
  it("returns undefined when no entry matches and there is no catch-all", () => {
    const workflows = [
      { match: "dependabot[bot]", workflowId: "dependabot-pr" },
      { match: "renovate[bot]", workflowId: "renovate-pr" },
    ];

    expect(matchWorkflowId("octocat", workflows)).toBeUndefined();
  });
});
