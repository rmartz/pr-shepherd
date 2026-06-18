import type { PrSnapshot } from "./types";
import { CopilotState } from "./state-vector";

// ---------------------------------------------------------------------------
// Copilot axis derivation (#96).
//
// Copilot authorship is detected by author NAME or LOGIN containing "copilot"
// (two author shapes: a login like `copilot-pull-request-reviewer[bot]` and a
// display name like "GitHub Copilot"). A Copilot REFUSAL ("wasn't able to
// review") advances a "last copilot review incl. refusals" notion but is NOT an
// actual review — so a PR whose only Copilot activity is a refusal still counts
// as AWAITING_REVIEW, not RESOLVED.
// ---------------------------------------------------------------------------

const REFUSAL_MARKERS = [
  "wasn't able to review",
  "was not able to review",
  "couldn't review",
  "could not review",
  "unable to review",
];

export function isCopilotActor(actor: string | undefined): boolean {
  return actor?.toLowerCase().includes("copilot") ?? false;
}

function isRefusal(body: string): boolean {
  const lower = body.toLowerCase();
  return REFUSAL_MARKERS.some((marker) => lower.includes(marker));
}

// An actual (non-refusal) Copilot review: a Copilot-authored review whose body
// is not a refusal notice, or any Copilot-authored review thread.
function hasActualCopilotReview(snapshot: PrSnapshot): boolean {
  const reviewed = snapshot.reviews.some(
    (r) => isCopilotActor(r.author) && !isRefusal(r.body),
  );
  const threaded = snapshot.reviewThreads.some((t) =>
    isCopilotActor(t.firstCommentAuthor),
  );
  return reviewed || threaded;
}

// Copilot left at least one notice (review OR refusal comment) — i.e. it was
// invoked and responded in some form.
function copilotResponded(snapshot: PrSnapshot): boolean {
  const reviewed = snapshot.reviews.some((r) => isCopilotActor(r.author));
  const commented = snapshot.issueComments.some((c) =>
    isCopilotActor(c.author),
  );
  return reviewed || commented || hasActualCopilotReview(snapshot);
}

export function deriveCopilot(snapshot: PrSnapshot): CopilotState {
  if (!copilotResponded(snapshot)) return CopilotState.None;

  // Refusal-only (or invoked but no actual review yet) → still awaiting.
  if (!hasActualCopilotReview(snapshot)) return CopilotState.AwaitingReview;

  const openCopilotThread = snapshot.reviewThreads.some(
    (t) =>
      !t.isResolved && !t.isOutdated && isCopilotActor(t.firstCommentAuthor),
  );
  return openCopilotThread
    ? CopilotState.HasOpenThreads
    : CopilotState.Resolved;
}
