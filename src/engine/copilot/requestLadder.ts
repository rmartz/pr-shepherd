import type { PrSnapshot } from "@/engine/derivation";
import { ReviewState } from "@/engine/derivation";
import {
  actualCopilotReviewCoversHead,
  hasActualCopilotReview,
} from "./coverage";

// ---------------------------------------------------------------------------
// Copilot request ladder (issue #106).
//
// The automated reviewer is requested at three precise moments to collapse the
// latency between "approved" and "merge-candidate selected", with refusal-vs-
// review separation so an outage never spins or merges un-reviewed. Copilot is
// INFORMATIONAL, never a hard merge gate (bounded window).
//
//   Event A   — warmup: review-bound PR that never had an actual Copilot review,
//               so a first review is in-flight before the worker reaches /review.
//   Event A.5 — at approval: PR became approved without a review covering HEAD;
//               request once (session-deduped; failed requests retry next pass).
//   Event B   — merge-time double-check: PR is the merge candidate; request once
//               if no actual review covers the current commit, then wait capped.
//
// These are PURE gating predicates: they decide WHETHER a request should fire.
// The caller owns the side effect (the github_api request) and the session
// dedup store — `decide*` only reads it. A request that the caller fails to
// place is simply not recorded as sent, so the next pass re-fires it.
// ---------------------------------------------------------------------------

export enum CopilotRequestEvent {
  Approval = "approval", // Event A.5
  MergeTime = "merge_time", // Event B
  Warmup = "warmup", // Event A
}

// The pure facts the ladder reads. `isDependabot` and `inInteriorFixReview` are
// supplied by the caller (the orchestrator knows the workflow context); the rest
// derive from the snapshot. `sessionRequested` is the dedup predicate: has this
// (pr, event) request already been placed this session? Kept as a callback so
// the caller owns the store and its keying.
export interface CopilotLadderInput {
  snapshot: PrSnapshot;
  // True for Dependabot PRs — the ladder never requests Copilot for them.
  isDependabot: boolean;
  // True when the PR is inside an interior fix-review cycle (a child fix run or
  // mid review→fix loop) — the ladder does not request Copilot there.
  inInteriorFixReview: boolean;
  // The PR's derived review verdict — drives the warmup ("review-bound") and
  // approval predicates.
  review: ReviewState;
  // Has a request for this (pr, event) already been placed this session?
  sessionRequested: boolean;
}

// A request is categorically suppressed for Dependabot PRs and inside interior
// fix-review cycles, regardless of event.
function isSuppressed(input: CopilotLadderInput): boolean {
  return input.isDependabot || input.inInteriorFixReview;
}

// Event A — warmup. Request for a review-bound PR (not yet approved/rejected:
// the daemon will drive it to /review) that has never had an ACTUAL Copilot
// review, so the first review is in-flight before /review is reached. A refusal
// does not count as an actual review, so a refusal-only PR is still warmup-able.
export function shouldRequestWarmup(input: CopilotLadderInput): boolean {
  if (isSuppressed(input)) return false;
  if (input.sessionRequested) return false;
  const reviewBound =
    input.review === ReviewState.Unreviewed ||
    input.review === ReviewState.AwaitingReReview;
  if (!reviewBound) return false;
  return !hasActualCopilotReview(input.snapshot);
}

// Event A.5 — at approval. When a PR becomes approved without a current Copilot
// review (one covering HEAD), request once. Session-deduped; a failed request
// is not recorded, so it retries next pass.
export function shouldRequestAtApproval(input: CopilotLadderInput): boolean {
  if (isSuppressed(input)) return false;
  if (input.sessionRequested) return false;
  if (input.review !== ReviewState.Approved) return false;
  return !actualCopilotReviewCoversHead(input.snapshot);
}

// Event B — merge-time double-check. When a PR becomes the merge candidate,
// request once if no actual review covers the current commit. Session-deduped.
export function shouldRequestAtMergeTime(input: CopilotLadderInput): boolean {
  if (isSuppressed(input)) return false;
  if (input.sessionRequested) return false;
  return !actualCopilotReviewCoversHead(input.snapshot);
}

// Dispatch one predicate by event — convenience for a caller iterating events.
export function shouldRequestCopilot(
  event: CopilotRequestEvent,
  input: CopilotLadderInput,
): boolean {
  switch (event) {
    case CopilotRequestEvent.Approval:
      return shouldRequestAtApproval(input);
    case CopilotRequestEvent.MergeTime:
      return shouldRequestAtMergeTime(input);
    case CopilotRequestEvent.Warmup:
      return shouldRequestWarmup(input);
  }
}
