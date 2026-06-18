import type { PrSnapshot } from "./types";
import type { DeriveContext, PrStateVector } from "./state-vector";
import { MergeConflict, ThreadState, UATState } from "./state-vector";
import { deriveCi } from "./ci-axis";
import { deriveReview } from "./review-axis";
import { deriveCopilot } from "./copilot-axis";
import { deriveActivity, deriveHold } from "./hold-activity-axis";

// ---------------------------------------------------------------------------
// State-axis derivation (Epic 10, #96).
//
// `derivePrState` is a PURE, DETERMINISTIC, SIDE-EFFECT-FREE transform: a raw
// `PrSnapshot` (+ optional pure `DeriveContext`) in, a flat `PrStateVector`
// out. No GitHub calls, no db writes, no clock reads beyond `context.now`.
// Each of the 8 orthogonal axes is computed independently; the richest source
// of bugs is staleness, so "current" is answered by commit-OID graph position
// (review-axis) rather than by timestamps. Per-axis idiosyncrasies live in the
// axis modules this orchestrator composes.
// ---------------------------------------------------------------------------

const UAT_READY_LABELS = new Set(["ready for uat", "ready-for-uat"]);
const UAT_REQUIRED_LABELS = new Set(["needs uat", "needs-uat", "uat"]);
const UAT_TESTED_LABELS = new Set(["tested"]);

function hasLabel(snapshot: PrSnapshot, candidates: Set<string>): boolean {
  return snapshot.labels.some((l) => candidates.has(l.toLowerCase()));
}

function deriveConflict(snapshot: PrSnapshot): MergeConflict {
  // Raw `mergeable` passed through verbatim: only a definitive CONFLICTING
  // blocks downstream; UNKNOWN is mapped but treated as non-blocking by the
  // consumer (never inferred as CLEAN here).
  if (snapshot.mergeable === "CONFLICTING") return MergeConflict.Conflicting;
  if (snapshot.mergeable === "MERGEABLE") return MergeConflict.Clean;
  return MergeConflict.Unknown;
}

function deriveThreads(snapshot: PrSnapshot): ThreadState {
  // An outdated thread no longer points at live code, so it does not gate.
  const open = snapshot.reviewThreads.some(
    (t) => !t.isResolved && !t.isOutdated,
  );
  return open ? ThreadState.Open : ThreadState.NoneOpen;
}

function deriveUat(snapshot: PrSnapshot): UATState {
  if (hasLabel(snapshot, UAT_TESTED_LABELS)) return UATState.Tested;
  if (hasLabel(snapshot, UAT_READY_LABELS)) return UATState.ReadyUntested;
  if (hasLabel(snapshot, UAT_REQUIRED_LABELS)) return UATState.DecisionPending;
  return UATState.NotRequired;
}

export function derivePrState(
  snapshot: PrSnapshot,
  context: DeriveContext = {},
): PrStateVector {
  return {
    activity: deriveActivity(snapshot, context),
    ci: deriveCi(snapshot),
    conflict: deriveConflict(snapshot),
    copilot: deriveCopilot(snapshot),
    hold: deriveHold(snapshot, context),
    review: deriveReview(snapshot),
    threads: deriveThreads(snapshot),
    uat: deriveUat(snapshot),
  };
}
