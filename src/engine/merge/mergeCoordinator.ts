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
  Failed = "failed", // merge attempt errored — marked for re-review/fix
  Merged = "merged",
  Rejected = "rejected", // pre-validation failed (CI failed / conflict) — routed to fix
  Skipped = "skipped", // a merge is already in flight, or this (pr,headSha) already merged
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
}

export interface MergeCoordinator {
  attemptMerge: (attempt: MergeAttempt) => Promise<MergeOutcome>;
  // Whether a merge is currently in flight (the mutex is held).
  isMerging: () => boolean;
}

function idempotencyKey(repo: string, pr: number, headSha: string): string {
  return `${repo}#${String(pr)}@${headSha}`;
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
        } catch {
          await attempt.markForFix("merge_error");
          return MergeOutcome.Failed;
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
