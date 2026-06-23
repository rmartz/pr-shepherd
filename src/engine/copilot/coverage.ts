import {
  type PrSnapshot,
  isCopilotActor,
  isCopilotRefusal,
} from "@/engine/derivation";

// ---------------------------------------------------------------------------
// "Actual Copilot review coverage" derivation (issue #106).
//
// The request ladder needs a finer signal than the CopilotState axis (#96): not
// just "did Copilot ever review", but "does an ACTUAL (non-refusal) Copilot
// review cover the CURRENT HEAD commit". A refusal ("wasn't able to review")
// advances activity but is never a review, so it must not satisfy coverage — a
// real request still has to fire later. Coverage is answered by commit-OID
// graph position, mirroring the human review axis: a review covers HEAD iff the
// index of its `commitOid` in `commitOids` is >= the HEAD position.
// ---------------------------------------------------------------------------

function coversHead(
  commitOid: string | undefined,
  commitOids: string[],
): boolean {
  const headIndex = commitOids.length - 1;
  if (commitOid !== undefined) {
    const index = commitOids.indexOf(commitOid);
    if (index !== -1) return index >= headIndex;
  }
  // No usable OID → cannot prove staleness from position; treat as current.
  return true;
}

// True when an actual (non-refusal) Copilot review exists at all — regardless of
// which commit it covers. A refusal-only PR is false here.
export function hasActualCopilotReview(snapshot: PrSnapshot): boolean {
  return snapshot.reviews.some(
    (r) => isCopilotActor(r.author) && !isCopilotRefusal(r.body),
  );
}

// True when an actual Copilot review covers the CURRENT HEAD commit. This is the
// predicate the ladder uses to decide whether a fresh request is still needed:
// an actual review against an older commit does NOT cover a newer HEAD.
export function actualCopilotReviewCoversHead(snapshot: PrSnapshot): boolean {
  return snapshot.reviews.some(
    (r) =>
      isCopilotActor(r.author) &&
      !isCopilotRefusal(r.body) &&
      coversHead(r.commitOid, snapshot.commitOids),
  );
}

// True when Copilot's only response so far is a refusal/outage notice (a review
// or issue comment that is a refusal) and no actual review exists. The ladder
// uses this to clear a merge-time WAIT while still firing a real request later.
export function isCopilotRefusalOnly(snapshot: PrSnapshot): boolean {
  if (hasActualCopilotReview(snapshot)) return false;
  const refusedReview = snapshot.reviews.some(
    (r) => isCopilotActor(r.author) && isCopilotRefusal(r.body),
  );
  const refusedComment = snapshot.issueComments.some(
    (c) => isCopilotActor(c.author) && isCopilotRefusal(c.body),
  );
  return refusedReview || refusedComment;
}
