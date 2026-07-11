import type { PrSnapshot } from "@/engine/derivation";
import {
  CIState,
  CopilotState,
  deriveCi,
  deriveCopilot,
} from "@/engine/derivation";

// ---------------------------------------------------------------------------
// Wait-set clearance predicates (#110, design §6).
//
// A wait-set holds PRs that are blocked on an external state transition (CI or
// Copilot). Each bulk-poll cycle takes one fresh snapshot per PR and asks "has
// the thing we're waiting on landed?". The clearance predicate is the answer.
//
// The CI predicate is deliberately stricter than "CI is not running": the
// coordinator spec requires BOTH
//   (a) no GitHub-Actions suite is still running, AND
//   (b) a landed verdict — a terminal CI conclusion (passed / failing /
//       cancelled / cancelled-retried), not a transient "needs auth" or
//       "running" state.
// A lone pending non-Actions status (e.g. Vercel) must never clear the wait,
// and an Actions suite mid-run must never be mistaken for a landed verdict.
// `deriveCi` (#96) already encodes the Actions-only rule; the predicate layers
// the "landed verdict" gate on top so a `NeedsAuth`/`Running` axis never clears.
// ---------------------------------------------------------------------------

// Which external signal a wait-set entry is blocked on. String values match
// the `wait_external` kind serialized in the workflow schema where they
// overlap; kept alphabetical per the repo enum convention.
export enum WaitKind {
  Ci = "ci",
  CopilotReview = "copilot_review",
}

// CI axis values that represent a landed verdict — a terminal conclusion the
// downstream gate can act on. `Running` (a suite still executing) and
// `NeedsAuth` (waiting for a maintainer to authorize the run) are NOT landed:
// the wait must continue until they resolve.
const LANDED_CI_STATES = new Set<CIState>([
  CIState.Cancelled,
  CIState.CancelledRetried,
  CIState.Failing,
  CIState.Passed,
]);

// True when CI has landed a verdict on the snapshot: no Actions suite is still
// running AND the derived axis is a terminal conclusion. Both conditions are
// required — see the module header.
export function isCiCleared(snapshot: PrSnapshot): boolean {
  return LANDED_CI_STATES.has(deriveCi(snapshot));
}

// True when Copilot has produced a reviewable verdict: it has either resolved
// (no open threads) or surfaced open threads to act on. `AwaitingReview` (the
// request is still pending) and `None` (no review requested) are NOT cleared —
// the wait continues until Copilot responds.
export function isCopilotCleared(snapshot: PrSnapshot): boolean {
  const state = deriveCopilot(snapshot);
  return (
    state === CopilotState.HasOpenThreads || state === CopilotState.Resolved
  );
}

// Dispatch a snapshot to the predicate for its wait kind. Exhaustive over
// `WaitKind` so adding a kind without a predicate is a compile error.
export function isWaitCleared(kind: WaitKind, snapshot: PrSnapshot): boolean {
  switch (kind) {
    case WaitKind.Ci:
      return isCiCleared(snapshot);
    case WaitKind.CopilotReview:
      return isCopilotCleared(snapshot);
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown wait kind: ${String(exhaustive)}`);
    }
  }
}
