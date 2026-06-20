import { describe, it, expect } from "vitest";
import { derivePrState } from "../axes";
import { DependabotRebaseState } from "../state-vector";
import { makePrSnapshot } from "./fixtures";

// ---------------------------------------------------------------------------
// Dependabot rebase axis (#199). The marker lives in the PR body; the axis
// reads it through `context.state.dependabotRebase`. Each test sets only the
// body so a failure points at the marker logic alone.
// ---------------------------------------------------------------------------

describe("DependabotRebaseState: derives the rebase marker from the PR body", () => {
  it("is None when the body carries no marker", () => {
    const snap = makePrSnapshot({
      body: "Bumps lodash from 4.17.20 to 4.17.21.",
    });
    expect(derivePrState(snap).dependabotRebase).toBe(
      DependabotRebaseState.None,
    );
  });

  it("is InProgress when the body says Dependabot is rebasing this PR", () => {
    const snap = makePrSnapshot({
      body: "Bumps lodash.\n\nDependabot is rebasing this PR and will replace this comment.",
    });
    expect(derivePrState(snap).dependabotRebase).toBe(
      DependabotRebaseState.InProgress,
    );
  });

  it("is Failed when the body says Dependabot rebase failed", () => {
    const snap = makePrSnapshot({
      body: "Bumps lodash.\n\nDependabot rebase failed: merge conflict.",
    });
    expect(derivePrState(snap).dependabotRebase).toBe(
      DependabotRebaseState.Failed,
    );
  });

  it("matches the in-progress marker case-insensitively", () => {
    const snap = makePrSnapshot({
      body: "DEPENDABOT IS REBASING THIS PR",
    });
    expect(derivePrState(snap).dependabotRebase).toBe(
      DependabotRebaseState.InProgress,
    );
  });

  it("prefers the failed state when both lines somehow appear", () => {
    const snap = makePrSnapshot({
      body: "Dependabot is rebasing this PR\nDependabot rebase failed",
    });
    expect(derivePrState(snap).dependabotRebase).toBe(
      DependabotRebaseState.Failed,
    );
  });
});
