// ---------------------------------------------------------------------------
// Merge-candidate arbitration (Epic 10, #99).
//
// The gate model (`decide`, #98) marks EVERY merge-ready PR with `Action.Merge`,
// but merges are globally serialized (design doc §6; #104) — only one PR may
// merge per pass. `selectMergeCandidate` is the pure tie-break that picks that
// single winner from the set of decided candidates.
//
// Purity is structural: no I/O, no clock reads. Every fact the arbitration needs
// (the decided action, the priority class, files changed, creation time) is
// baked into each `Candidate` by the impure derivation/decision steps upstream.
// ---------------------------------------------------------------------------

import { Action } from "./actions";

// How a candidate is prioritized relative to the rest of the queue. Higher-rank
// classes merge first: a hotfix unblocks a broken `main` and a Dependabot-fix
// unblocks the Dependabot PR it was spawned to repair, so both jump ahead of
// ordinary PRs (Coordinator spec §3). Members are alphabetical per the enum
// convention; the load-bearing *priority* order is `MERGE_PRIORITY_RANK` below,
// decoupled from the enum's declaration order exactly like `GATE_ORDER`.
export enum MergePriority {
  Dependabot = "dependabot",
  DependabotFix = "dependabot_fix",
  Hotfix = "hotfix",
  Normal = "normal",
}

// One PR offered to arbitration. Deliberately the minimal projection the
// tie-break reads — not the full snapshot — so the function stays pure data-in,
// data-out and trivial to fixture in tests.
export interface Candidate {
  // The PR number, carried through so the caller can act on the winner.
  prNumber: number;
  // The action `decide` returned for this PR. Only `Action.Merge` candidates
  // are eligible; everything else is ignored (it is being reviewed / fixed /
  // waited on, not merged).
  action: Action;
  // The priority class this PR belongs to (see `MergePriority`).
  priority: MergePriority;
  // Number of files the PR changes. The primary tie-break within a priority
  // class: the largest PR merges first to clear the most blocking surface area
  // and minimize the rebase churn it inflicts on the rest of the queue.
  changedFiles: number;
  // PR creation time as an ISO-8601 string (GitHub's `createdAt`). The
  // secondary tie-break: oldest first, so an equally-large older PR is not
  // starved behind newer arrivals.
  createdAt: string;
}

// Lower number = merges first. Decoupled from the `MergePriority` enum's
// alphabetical declaration order so the priority order is explicit and editable
// without reordering the enum (the same split `decide.ts` makes for gates).
const MERGE_PRIORITY_RANK: Record<MergePriority, number> = {
  [MergePriority.Hotfix]: 0,
  [MergePriority.DependabotFix]: 1,
  [MergePriority.Normal]: 2,
  [MergePriority.Dependabot]: 3,
};

// A total ordering over eligible candidates: priority rank first, then most
// files changed, then oldest `createdAt`. Returns < 0 when `a` should merge
// before `b`. The `createdAt` tie-break makes the order total — two distinct
// PRs created at the same instant with identical size keep a stable
// (PR-number) order so the result never depends on input ordering.
function compareCandidates(a: Candidate, b: Candidate): number {
  const rankDelta =
    MERGE_PRIORITY_RANK[a.priority] - MERGE_PRIORITY_RANK[b.priority];
  if (rankDelta !== 0) {
    return rankDelta;
  }
  if (a.changedFiles !== b.changedFiles) {
    return b.changedFiles - a.changedFiles;
  }
  const timeDelta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  return a.prNumber - b.prNumber;
}

// Select the single PR to merge this pass from the decided set, or `undefined`
// when none is merge-eligible. Pure: it neither mutates `candidates` nor reads
// the clock — the winner is a deterministic function of the input alone.
export function selectMergeCandidate(
  candidates: readonly Candidate[],
): Candidate | undefined {
  const eligible = candidates.filter(
    (candidate) => candidate.action === Action.Merge,
  );
  if (eligible.length === 0) {
    return undefined;
  }
  return eligible.reduce((best, candidate) =>
    compareCandidates(candidate, best) < 0 ? candidate : best,
  );
}
