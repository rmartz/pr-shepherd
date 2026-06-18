import type { PrSnapshot, ReviewSnapshot } from "./types";
import { ReviewState } from "./state-vector";
import { isCopilotActor } from "./copilot-axis";

// ---------------------------------------------------------------------------
// Review axis derivation (#96).
//
// "Current" is answered by commit-OID graph position, not timestamps: a review
// covers HEAD iff the index of its `commitOid` in `commitOids` is >= the index
// of the latest code commit (the HEAD position). Author-timestamp comparison
// is the fallback when a review's OID is missing or not in the commit list.
//
// A never-reviewed PR is UNREVIEWED, never AWAITING_RE_REVIEW. Copilot reviews
// do not establish a human review verdict, so they are excluded here.
// ---------------------------------------------------------------------------

// States that represent a submitted human verdict (PENDING = unsubmitted).
const VERDICT_STATES = new Set(["APPROVED", "CHANGES_REQUESTED"]);

function humanVerdictReviews(snapshot: PrSnapshot): ReviewSnapshot[] {
  return snapshot.reviews.filter(
    (r) => VERDICT_STATES.has(r.state) && !isCopilotActor(r.author),
  );
}

// True when the review covers HEAD. Primary signal: OID graph position.
function coversHead(review: ReviewSnapshot, commitOids: string[]): boolean {
  const headIndex = commitOids.length - 1;
  if (review.commitOid !== undefined) {
    const index = commitOids.indexOf(review.commitOid);
    if (index !== -1) return index >= headIndex;
  }
  // Fallback: no usable OID → assume current (timestamp ordering already put
  // this review last; staleness can't be proven from position).
  return true;
}

// The latest verdict is the one whose review is newest by submission time;
// ties fall back to array order (REST returns reviews chronologically).
function latestVerdict(reviews: ReviewSnapshot[]): ReviewSnapshot {
  return reviews.reduce((latest, candidate) => {
    const a = Date.parse(candidate.submittedAt ?? "") || 0;
    const b = Date.parse(latest.submittedAt ?? "") || 0;
    return a >= b ? candidate : latest;
  });
}

export function deriveReview(snapshot: PrSnapshot): ReviewState {
  const verdicts = humanVerdictReviews(snapshot);
  if (verdicts.length === 0) return ReviewState.Unreviewed;

  const latest = latestVerdict(verdicts);
  if (latest.state === "CHANGES_REQUESTED") {
    return ReviewState.ChangesRequested;
  }

  // APPROVED: current only if it covers HEAD; otherwise a newer code commit
  // has landed and the approval needs to be re-collected.
  return coversHead(latest, snapshot.commitOids)
    ? ReviewState.Approved
    : ReviewState.AwaitingReReview;
}
