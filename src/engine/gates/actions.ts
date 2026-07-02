// ---------------------------------------------------------------------------
// Gate-model vocabulary (Epic 10, #98): the closed set of `Action`s a gate can
// demand and the ordered `Gate` list the decision walks.
//
// Both are string enums whose members are kept in alphabetical order per the
// repo enum convention; the *priority* order of gates is a separate constant
// (`GATE_ORDER` in `decide.ts`) so the enum's alphabetical ordering and the
// load-bearing evaluation order are decoupled.
// ---------------------------------------------------------------------------

// The atomic task types a gate routes to. These mirror the catalog in the
// PR-lifecycle design doc §4; the `evaluate_gates` step maps each to a concrete
// next workflow step.
export enum Action {
  AuthorizeCi = "authorize_ci",
  Escalate = "escalate",
  FixReview = "fix_review",
  Merge = "merge",
  Park = "park",
  RerunCi = "rerun_ci",
  Review = "review",
  WaitCi = "wait_ci",
  WaitCopilot = "wait_copilot",
  WaitRemote = "wait_remote",
}

// The prerequisites checked in priority order. The first unsatisfied gate
// decides the action; if all pass, the PR merges (the terminal `Merge` gate).
export enum Gate {
  CiGreen = "ci_green",
  CodeApproved = "code_approved",
  CopilotSettled = "copilot_settled",
  Merge = "merge",
  NoConflict = "no_conflict",
  NoHold = "no_hold",
  NotWip = "not_wip",
  ReviewedBySkill = "reviewed_by_skill",
  ThreadsResolved = "threads_resolved",
  UatCleared = "uat_cleared",
}

// The single decision a cycle yields for a PR: the action to take and the gate
// that demanded it (the first unsatisfied one, or `Gate.Merge` when all pass).
export interface GateDecision {
  action: Action;
  blockingGate: Gate;
}

// Pure context flags the caller supplies alongside the state vector. Both are
// data-only so `decide` stays a deterministic transformation.
export interface DecideOptions {
  // When true, the automated reviewer (Copilot) is treated as unavailable: the
  // `COPILOT_SETTLED` gate is satisfied regardless of the copilot axis, because
  // a refusal/outage clears the *wait* but is never a hard gate.
  copilotUnavailable?: boolean;
  // When true, the `UAT_CLEARED` gate is satisfied regardless of the uat axis
  // (the workflow has opted out of human acceptance testing for this PR).
  skipUat?: boolean;
}
