// ---------------------------------------------------------------------------
// The total gate decision (Epic 10, #98).
//
// `decide(state, opts?)` walks an ordered list of gates over a `PrStateVector`.
// Each gate reports whether its prerequisite is satisfied; the FIRST unsatisfied
// gate decides the action. If every gate passes, the PR merges. The function is
// **total**: every reachable axis combination maps to exactly one `Action` and
// never throws or falls through (the totality test enumerates the full product).
//
// Purity is structural: no I/O, no clock reads. Any clock-dependent input is
// already baked into the state vector by the (impure) derivation step.
// ---------------------------------------------------------------------------

import {
  CIState,
  CopilotState,
  HoldState,
  MergeConflict,
  ReviewState,
  ThreadState,
  UATState,
  type PrStateVector,
} from "../derivation";
import { Action, Gate, type DecideOptions, type GateDecision } from "./actions";

// A gate is satisfied (returns `undefined`) or blocks with a concrete action.
type GateResult = Action | undefined;
type GateCheck = (state: PrStateVector, opts: DecideOptions) => GateResult;

// The action demanded by an unsatisfied CI gate. `Passed` is the only satisfied
// state; every other CI verdict routes to a distinct recovery action. A
// `CancelledRetried` run has already used its one-shot rerun, so it ESCALATES —
// applies the sticky `escalation needed` label so a human is surfaced instead of
// the PR silently re-parking every tick (#253). The escalate action fires
// exactly once: once the label lands, `NoHold` (ordered before `CiGreen`) parks
// the PR before this gate is reached again. A CI-failing PR that was never
// reviewed routes to REVIEW (render a first verdict), not FIX_REVIEW.
function ciGate(state: PrStateVector): GateResult {
  switch (state.ci) {
    case CIState.Passed:
      return undefined;
    case CIState.NeedsAuth:
      return Action.AuthorizeCi;
    case CIState.Cancelled:
      return Action.RerunCi;
    case CIState.CancelledRetried:
      return Action.Escalate;
    case CIState.Running:
      return Action.WaitCi;
    case CIState.Failing:
      return state.review === ReviewState.Unreviewed
        ? Action.Review
        : Action.FixReview;
  }
}

// The conflict gate. A conflicting branch needs a fix-review push; an unknown
// mergeability is GitHub still computing it, so wait for the remote.
function conflictGate(state: PrStateVector): GateResult {
  switch (state.conflict) {
    case MergeConflict.Clean:
      return undefined;
    case MergeConflict.Conflicting:
      return Action.FixReview;
    case MergeConflict.Unknown:
      return Action.WaitRemote;
  }
}

// The review gate. Only an `Approved` verdict on the current HEAD satisfies it;
// changes-requested routes to a fix, everything else to a fresh review.
function reviewGate(state: PrStateVector): GateResult {
  switch (state.review) {
    case ReviewState.Approved:
      return undefined;
    case ReviewState.ChangesRequested:
      return Action.FixReview;
    case ReviewState.AwaitingReReview:
    case ReviewState.Unreviewed:
      return Action.Review;
  }
}

// The copilot gate. `copilotUnavailable` short-circuits it to satisfied (a
// refusal/outage clears the wait, never a hard gate). Otherwise an awaiting
// review waits; open copilot threads route to a fix.
function copilotGate(state: PrStateVector, opts: DecideOptions): GateResult {
  if (opts.copilotUnavailable) {
    return undefined;
  }
  switch (state.copilot) {
    case CopilotState.None:
    case CopilotState.Resolved:
      return undefined;
    case CopilotState.AwaitingReview:
      return Action.WaitCopilot;
    case CopilotState.HasOpenThreads:
      return Action.FixReview;
  }
}

// The UAT gate. `skipUat` short-circuits it to satisfied. A pending decision or
// untested-but-ready PR parks until a human acts; that PARK auto-resumes when
// the UAT axis advances on the next derivation.
function uatGate(state: PrStateVector, opts: DecideOptions): GateResult {
  if (opts.skipUat) {
    return undefined;
  }
  switch (state.uat) {
    case UATState.NotRequired:
    case UATState.Tested:
      return undefined;
    case UATState.DecisionPending:
    case UATState.ReadyUntested:
      return Action.Park;
  }
}

// The ordered gate table. Order is load-bearing (design doc §3): cheap decisive
// gates first; `NO_HOLD` is skipped when CONFLICTING (the conflict resolves
// regardless); `DO_NOT_MERGE` is a merge-only hold handled last.
const GATE_ORDER: readonly (readonly [Gate, GateCheck])[] = [
  // A WIP/draft PR is parked before any expensive preparatory work.
  [
    Gate.NotWip,
    (state) =>
      state.hold === HoldState.Wip || state.hold === HoldState.Draft
        ? Action.Park
        : undefined,
  ],
  // Escalation / blocked-on-issue holds park the PR — but are SKIPPED when the
  // branch is also conflicting, because the conflict must resolve regardless.
  [
    Gate.NoHold,
    (state) =>
      (state.hold === HoldState.EscalationNeeded ||
        state.hold === HoldState.BlockedOnIssue) &&
      state.conflict !== MergeConflict.Conflicting
        ? Action.Park
        : undefined,
  ],
  [Gate.CiGreen, ciGate],
  [Gate.NoConflict, conflictGate],
  [Gate.CodeApproved, reviewGate],
  // Open review threads need a review pass to render a verdict and reconcile
  // resolved threads.
  [
    Gate.ThreadsResolved,
    (state) => (state.threads === ThreadState.Open ? Action.Review : undefined),
  ],
  [Gate.CopilotSettled, copilotGate],
  [Gate.UatCleared, uatGate],
  // REVIEWED_BY_SKILL: reaching here implies an APPROVED verdict (CODE_APPROVED
  // already passed), which is the skill's standing review. No axis distinguishes
  // a stale skill review from a fresh one, so the gate is satisfied here.
  [Gate.ReviewedBySkill, () => undefined],
];

// `decide` walks `GATE_ORDER`; the first gate that blocks yields its action.
// If all pass, the terminal MERGE gate applies: `DO_NOT_MERGE` is a merge-only
// hold that parks here (still reviewed / built / resolved above), otherwise the
// PR merges.
export function decide(
  state: PrStateVector,
  opts: DecideOptions = {},
): GateDecision {
  for (const [gate, check] of GATE_ORDER) {
    const action = check(state, opts);
    if (action !== undefined) {
      return { action, blockingGate: gate };
    }
  }
  return {
    action: state.hold === HoldState.DoNotMerge ? Action.Park : Action.Merge,
    blockingGate: Gate.Merge,
  };
}
