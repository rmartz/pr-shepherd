import {
  CIState,
  CopilotState,
  MergeConflict,
  type PrStateVector,
} from "@/engine/derivation";

// ---------------------------------------------------------------------------
// Pre-merge re-validation (issue #104).
//
// The gate model (#98) decides a PR is merge-ready, but the volatile axes
// (CI, conflict, Copilot) can change between that decision and the actual
// merge. Immediately before merging, the daemon re-derives fresh state and
// re-checks just those axes here. Crucially this distinguishes **CI still
// running** (defer + re-poll — not a failure) from **CI failed** (kick back to
// fix-review), the split the merge path must get right to avoid both premature
// merges and spurious fix loops. Review/hold/UAT are the gate model's domain;
// this only re-validates what can drift under propagation lag.
// ---------------------------------------------------------------------------

export enum MergeReadiness {
  CiFailed = "ci_failed", // CI failed/cancelled → kick to fix-review
  CiRunning = "ci_running", // CI in progress or awaiting auth → defer, re-poll
  Conflicting = "conflicting", // merge conflict → kick to fix-review
  CopilotPending = "copilot_pending", // Copilot not settled → defer, re-poll
  Ready = "ready", // clean, passed, settled → safe to merge now
}

// Map a freshly-derived state vector to its merge readiness. Pure. The
// precedence returns the most actionable blocker first: a conflict or a real
// CI failure (both → fix) outrank a transient "still running"/"awaiting
// Copilot" (both → defer).
export function assessMergeReadiness(state: PrStateVector): MergeReadiness {
  if (state.conflict === MergeConflict.Conflicting) {
    return MergeReadiness.Conflicting;
  }
  if (
    state.ci === CIState.Failing ||
    state.ci === CIState.Cancelled ||
    state.ci === CIState.CancelledRetried
  ) {
    return MergeReadiness.CiFailed;
  }
  if (state.ci === CIState.Running || state.ci === CIState.NeedsAuth) {
    return MergeReadiness.CiRunning;
  }
  if (
    state.copilot === CopilotState.AwaitingReview ||
    state.copilot === CopilotState.HasOpenThreads
  ) {
    return MergeReadiness.CopilotPending;
  }
  return MergeReadiness.Ready;
}
