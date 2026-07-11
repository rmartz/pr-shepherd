import {
  Activity,
  CIState,
  CopilotState,
  DependabotRebaseState,
  HoldState,
  MergeConflict,
  ReviewState,
  ThreadState,
  UATState,
  type PrStateVector,
} from "../../derivation";
import { Action } from "../actions";
import { MergePriority, type Candidate } from "../mergeCandidate";

// A fully-mergeable baseline: every gate satisfied, so `decide` returns MERGE.
// Tests override exactly the axes under test so a failure points at one cause.
// Every axis is set to an explicit, non-default value (Test Design: control
// inputs) — the activity axis is observational and never read by `decide`.
export function makePrStateVector(
  overrides: Partial<PrStateVector> = {},
): PrStateVector {
  return {
    activity: Activity.Active,
    ci: CIState.Passed,
    conflict: MergeConflict.Clean,
    copilot: CopilotState.Resolved,
    dependabotRebase: DependabotRebaseState.None,
    hold: HoldState.None,
    review: ReviewState.Approved,
    threads: ThreadState.NoneOpen,
    uat: UATState.Tested,
    ...overrides,
  };
}

// A merge-eligible arbitration candidate. Every field is set to an explicit,
// non-default value (Test Design: control inputs) so a passing test proves the
// arbitration produced the result, not an initializer. Tests override only the
// axis under test — e.g. `changedFiles` for the size tie-break.
export function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    prNumber: 7,
    action: Action.Merge,
    priority: MergePriority.Normal,
    changedFiles: 5,
    createdAt: "2026-06-01T12:00:00Z",
    ...overrides,
  };
}

// The per-axis value lists used by the totality test to enumerate the full
// cartesian product. Kept here so a new axis value forces a deliberate edit.
export const AXIS_VALUES = {
  activity: Object.values(Activity),
  ci: Object.values(CIState),
  conflict: Object.values(MergeConflict),
  copilot: Object.values(CopilotState),
  hold: Object.values(HoldState),
  review: Object.values(ReviewState),
  threads: Object.values(ThreadState),
  uat: Object.values(UATState),
} as const;
