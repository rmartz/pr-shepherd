import { ESCALATION_THRESHOLD } from "./attemptLedger";
import { classifyMergeError, mergeErrorMessage } from "./errorClassification";
import { MergeReadiness } from "./readiness";

// ---------------------------------------------------------------------------
// Merge serialization (issue #104).
//
// A single global merge path: at most one merge in flight across all PRs (only
// one can win a fast-forward race, and `main` advances one observable step at a
// time), with an idempotency key so a crash-after-merge retry never double-acts
// and a just-merged PR isn't re-selected while GitHub's propagation lags.
//
// The coordinator owns only the serialization + routing; the caller injects the
// volatile-state re-validation and the side-effecting merge/kickback, so this
// is pure to test and the actual GitHub mutation still flows through the
// `github_api` queue (capability isolation).
// ---------------------------------------------------------------------------

export enum MergeOutcome {
  Deferred = "deferred", // not ready yet (CI running / Copilot pending) — re-poll
  Escalated = "escalated", // failure is operator-actionable or hit the retry budget — sticky `escalation needed`
  Failed = "failed", // merge attempt errored (transient, under budget) — marked for re-review/fix
  Merged = "merged",
  Rejected = "rejected", // pre-validation failed (CI failed / conflict) — routed to fix
  Skipped = "skipped", // a merge is already in flight, or this (pr,headSha) already merged
}

// The durable retry-budget seam (#252). Optional on a `MergeAttempt`: when the
// caller wires it, a transient merge failure is counted per (PR, head SHA) and
// escalated at `ESCALATION_THRESHOLD`; an operator-actionable failure escalates
// immediately. Production reads/writes hidden marker comments on the PR (see
// `attemptLedger`); tests inject fakes. When omitted, a merge error routes to
// fix-review as before (no durable budget).
export interface MergeBudget {
  // Prior transient failures recorded against this (PR, head SHA), already
  // discounted for a new HEAD or a cleared `escalation needed` label.
  count: () => Promise<number>;
  // Persist a "will retry" marker for this failed attempt.
  record: () => Promise<void>;
  // Apply sticky `escalation needed` (blocking the PR from re-selection via the
  // gate model) and record a repeated-failure ledger occurrence.
  escalate: () => Promise<void>;
}

export interface MergeAttempt {
  repo: string;
  pr: number;
  // The HEAD the merge is validated and performed against; the second half of
  // the idempotency key.
  headSha: string;
  // Re-derive fresh state and assess merge readiness, immediately before merge.
  revalidate: () => Promise<MergeReadiness>;
  // Perform the actual squash-merge (via the github_api queue). Throwing routes
  // the PR to fix-review (Failed) rather than retrying in place.
  merge: () => Promise<void>;
  // Kick the PR back to review/fix with the reason (CI failed, conflict, or a
  // failed merge attempt).
  markForFix: (reason: MergeReadiness | "merge_error") => Promise<void>;
  // Optional durable retry-budget seam (#252). When present, a merge error is
  // classified and either escalated immediately (operator-actionable) or counted
  // toward the per-(PR, head SHA) budget.
  budget?: MergeBudget;
}

export interface MergeCoordinator {
  attemptMerge: (attempt: MergeAttempt) => Promise<MergeOutcome>;
  // Whether a merge is currently in flight (the mutex is held).
  isMerging: () => boolean;
}

function idempotencyKey(repo: string, pr: number, headSha: string): string {
  return `${repo}#${String(pr)}@${headSha}`;
}

// Route a failed merge attempt. Without a wired budget, a merge error kicks the
// PR back to fix-review as before. With one: an operator-actionable failure
// escalates immediately (it can never succeed on retry, so no budget is spent),
// while a transient failure is recorded against the per-(PR, head SHA) budget
// and escalates only once it reaches `ESCALATION_THRESHOLD`.
async function handleMergeError(
  attempt: MergeAttempt,
  error: unknown,
): Promise<MergeOutcome> {
  const budget = attempt.budget;
  if (budget === undefined) {
    await attempt.markForFix("merge_error");
    return MergeOutcome.Failed;
  }

  if (classifyMergeError(mergeErrorMessage(error)) === "operator_actionable") {
    await budget.escalate();
    return MergeOutcome.Escalated;
  }

  const priorFailures = await budget.count();
  await budget.record();
  if (priorFailures + 1 >= ESCALATION_THRESHOLD) {
    await budget.escalate();
    return MergeOutcome.Escalated;
  }

  await attempt.markForFix("merge_error");
  return MergeOutcome.Failed;
}

// One coordinator per daemon process. Holds the in-flight mutex and the set of
// already-merged `(pr, headSha)` keys (idempotency + merged-state lag).
export function createMergeCoordinator(): MergeCoordinator {
  let inFlight = false;
  const merged = new Set<string>();

  async function attemptMerge(attempt: MergeAttempt): Promise<MergeOutcome> {
    const key = idempotencyKey(attempt.repo, attempt.pr, attempt.headSha);
    // Idempotency + lag: this exact HEAD already merged — never re-act, even if
    // GitHub still reports the PR open. A new commit changes headSha → eligible.
    if (merged.has(key)) return MergeOutcome.Skipped;
    // Mutex: only one merge proceeds at a time.
    if (inFlight) return MergeOutcome.Skipped;

    inFlight = true;
    try {
      const readiness = await attempt.revalidate();
      if (readiness === MergeReadiness.Ready) {
        try {
          await attempt.merge();
          merged.add(key);
          return MergeOutcome.Merged;
        } catch (error) {
          return await handleMergeError(attempt, error);
        }
      }
      if (
        readiness === MergeReadiness.CiRunning ||
        readiness === MergeReadiness.CopilotPending
      ) {
        return MergeOutcome.Deferred;
      }
      // CiFailed | Conflicting — kick back to fix-review.
      await attempt.markForFix(readiness);
      return MergeOutcome.Rejected;
    } finally {
      inFlight = false;
    }
  }

  return { attemptMerge, isMerging: () => inFlight };
}
