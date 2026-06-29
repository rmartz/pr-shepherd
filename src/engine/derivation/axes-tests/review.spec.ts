import { describe, it, expect } from "vitest";
import { derivePrState } from "../axes";
import { ReviewState } from "../state-vector";
import { makePrSnapshot, makeReview } from "./fixtures";

// ReviewState axis. "Current" is decided by commit-OID graph position: a review
// covers HEAD iff its commit index >= the latest code-commit index.

describe("ReviewState: a never-reviewed PR is UNREVIEWED", () => {
  it("is UNREVIEWED with no reviews, never AWAITING_RE_REVIEW", () => {
    const snap = makePrSnapshot({ reviews: [] });
    expect(derivePrState(snap).review).toBe(ReviewState.Unreviewed);
  });

  it("ignores PENDING (unsubmitted) reviews", () => {
    const snap = makePrSnapshot({
      reviews: [makeReview({ state: "PENDING", submittedAt: undefined })],
    });
    expect(derivePrState(snap).review).toBe(ReviewState.Unreviewed);
  });

  it("ignores COMMENTED reviews (not a verdict)", () => {
    const snap = makePrSnapshot({
      reviews: [makeReview({ state: "COMMENTED", commitOid: "oid-head" })],
    });
    expect(derivePrState(snap).review).toBe(ReviewState.Unreviewed);
  });

  it("ignores DISMISSED reviews (not a verdict)", () => {
    const snap = makePrSnapshot({
      reviews: [makeReview({ state: "DISMISSED", commitOid: "oid-head" })],
    });
    expect(derivePrState(snap).review).toBe(ReviewState.Unreviewed);
  });
});

describe("ReviewState: APPROVED when the latest review approves HEAD", () => {
  it("is APPROVED when the approving review covers the head commit", () => {
    const snap = makePrSnapshot({
      commitOids: ["oid-old", "oid-head"],
      reviews: [makeReview({ state: "APPROVED", commitOid: "oid-head" })],
    });
    expect(derivePrState(snap).review).toBe(ReviewState.Approved);
  });
});

describe("ReviewState: CHANGES_REQUESTED blocks until re-review", () => {
  it("is CHANGES_REQUESTED when the latest review on HEAD requests changes", () => {
    const snap = makePrSnapshot({
      reviews: [
        makeReview({ state: "CHANGES_REQUESTED", commitOid: "oid-head" }),
      ],
    });
    expect(derivePrState(snap).review).toBe(ReviewState.ChangesRequested);
  });
});

describe("ReviewState: AWAITING_RE_REVIEW once a new commit lands", () => {
  it("is AWAITING_RE_REVIEW when an approval predates a newer code commit (OID position)", () => {
    const snap = makePrSnapshot({
      commitOids: ["oid-reviewed", "oid-new"],
      headOid: "oid-new",
      reviews: [makeReview({ state: "APPROVED", commitOid: "oid-reviewed" })],
    });
    expect(derivePrState(snap).review).toBe(ReviewState.AwaitingReReview);
  });

  it("stays APPROVED when the approval's OID is unknown but its timestamp is newest (fallback)", () => {
    const snap = makePrSnapshot({
      commitOids: ["oid-old", "oid-head"],
      reviews: [
        makeReview({
          state: "APPROVED",
          commitOid: undefined,
          submittedAt: "2030-01-01T00:00:00Z",
        }),
      ],
    });
    expect(derivePrState(snap).review).toBe(ReviewState.Approved);
  });
});
