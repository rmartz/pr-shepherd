// ---------------------------------------------------------------------------
// Atomic verdict-label reconciliation (Epic 10, #101).
//
// A PR carries at most one *verdict label* — the review system's current
// conclusion about it. The verdict labels are mutually exclusive: applying one
// must remove every other in a single operation (design doc §4 review, §6 atomic
// verdict labels). Doing this non-atomically is what produces the documented
// error state of a PR carrying two contradictory verdicts (e.g. both `approved`
// and `changes requested`), which the gate model would then read inconsistently.
//
// This module computes the *label mutation* a `github_api` step applies; it is
// pure (label set in → add/remove sets out) so the executor that mutates GitHub
// stays a thin, capability-isolated wrapper. It serves two callers:
//   - `reconcileVerdict` — set the verdict to a chosen value, removing the rest.
//   - `healVerdict`      — detect and repair a PR already carrying two or more
//                          verdict labels, with no new verdict to apply.
// ---------------------------------------------------------------------------

// The mutually-exclusive review verdicts, each backed by its GitHub label name.
// Members are alphabetical per the repo enum convention; the *string values* are
// the exact label text the system writes and reads on GitHub.
export enum VerdictLabel {
  Approved = "approved",
  ChangesRequested = "changes requested",
  EscalationNeeded = "escalation needed",
  ReviewRequested = "review requested",
}

// Every verdict label as a set, for fast membership tests against a PR's labels.
const VERDICT_LABELS: ReadonlySet<VerdictLabel> = new Set(
  Object.values(VerdictLabel),
);

// Narrow an arbitrary label string to a `VerdictLabel` when it is one. Used as a
// type predicate so the filtered list is typed as `VerdictLabel[]` and every
// downstream comparison is enum-to-enum (never string-vs-enum).
function isVerdictLabel(label: string): label is VerdictLabel {
  return VERDICT_LABELS.has(label as VerdictLabel);
}

// The label mutation a `github_api` step applies atomically: labels to add and
// labels to remove. Both are deduplicated and disjoint. An empty mutation
// (nothing to add or remove) means the PR is already consistent.
export interface LabelMutation {
  add: string[];
  remove: string[];
}

// The verdict labels currently present on a PR, in the order they appear in the
// PR's label list (used to pick a deterministic winner when healing).
function currentVerdicts(labels: readonly string[]): VerdictLabel[] {
  return labels.filter(isVerdictLabel);
}

// Compute the mutation that makes `verdict` the PR's sole verdict label: add it
// if absent, and remove every *other* verdict label currently present. Applying
// the result is a single atomic relabel — no intermediate state where the PR
// carries both the old and new verdict. Idempotent: if the PR already carries
// exactly `verdict` and no other, the mutation is empty.
export function reconcileVerdict(
  verdict: VerdictLabel,
  labels: readonly string[],
): LabelMutation {
  const present = new Set(labels);
  const add = present.has(verdict) ? [] : [verdict];
  const remove = currentVerdicts(labels).filter((label) => label !== verdict);
  return { add, remove };
}

// Detect and repair a PR carrying two or more contradictory verdict labels. The
// system actively heals this error state: it keeps the single highest-precedence
// verdict and removes the rest. Precedence (most → least urgent):
// `escalation needed` > `changes requested` > `review requested` > `approved` —
// a contradiction resolves toward the state that keeps the PR *out* of merge,
// never toward a spurious `approved`. With zero or one verdict label present the
// PR is already consistent and the mutation is empty.
const HEAL_PRECEDENCE: readonly VerdictLabel[] = [
  VerdictLabel.EscalationNeeded,
  VerdictLabel.ChangesRequested,
  VerdictLabel.ReviewRequested,
  VerdictLabel.Approved,
];

export function healVerdict(labels: readonly string[]): LabelMutation {
  const present = currentVerdicts(labels);
  if (present.length <= 1) {
    return { add: [], remove: [] };
  }
  const winner = HEAL_PRECEDENCE.find((label) => present.includes(label));
  return {
    add: [],
    remove: present.filter((label) => label !== winner),
  };
}
