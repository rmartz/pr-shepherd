import { describe, it, expect } from "vitest";
import { ReviewState } from "@/engine/derivation";
import {
  CopilotRequestEvent,
  shouldRequestAtApproval,
  shouldRequestAtMergeTime,
  shouldRequestCopilot,
  shouldRequestWarmup,
} from "../requestLadder";
import { makeLadderInput, makeReview, makeSnapshot } from "./fixtures";

describe("Event A (warmup): request for review-bound PRs with no actual review", () => {
  it("requests for an unreviewed PR that has never had a Copilot review", () => {
    expect(shouldRequestWarmup(makeLadderInput())).toBe(true);
  });

  it("requests for an awaiting-re-review PR with no actual Copilot review", () => {
    const input = makeLadderInput({ review: ReviewState.AwaitingReReview });
    expect(shouldRequestWarmup(input)).toBe(true);
  });

  it("does not request once an actual Copilot review exists", () => {
    const input = makeLadderInput({
      snapshot: makeSnapshot({ reviews: [makeReview()] }),
    });
    expect(shouldRequestWarmup(input)).toBe(false);
  });

  it("does not request for an already-approved PR (not review-bound)", () => {
    const input = makeLadderInput({ review: ReviewState.Approved });
    expect(shouldRequestWarmup(input)).toBe(false);
  });
});

describe("Event A.5 (at approval): request once when approved without a current review", () => {
  it("requests when approved and no actual Copilot review covers HEAD", () => {
    const input = makeLadderInput({ review: ReviewState.Approved });
    expect(shouldRequestAtApproval(input)).toBe(true);
  });

  it("does not request when an actual Copilot review already covers HEAD", () => {
    const input = makeLadderInput({
      review: ReviewState.Approved,
      snapshot: makeSnapshot({
        reviews: [makeReview({ commitOid: "oid-head" })],
      }),
    });
    expect(shouldRequestAtApproval(input)).toBe(false);
  });

  it("requests when the only Copilot review covers an older commit, not HEAD", () => {
    const input = makeLadderInput({
      review: ReviewState.Approved,
      snapshot: makeSnapshot({
        reviews: [makeReview({ commitOid: "oid-old" })],
      }),
    });
    expect(shouldRequestAtApproval(input)).toBe(true);
  });

  it("does not request for an unapproved PR", () => {
    const input = makeLadderInput({ review: ReviewState.Unreviewed });
    expect(shouldRequestAtApproval(input)).toBe(false);
  });
});

describe("Event B (merge-time): request once if no actual review covers the commit", () => {
  it("requests when the merge candidate has no actual review covering HEAD", () => {
    expect(shouldRequestAtMergeTime(makeLadderInput())).toBe(true);
  });

  it("does not request when an actual review already covers HEAD", () => {
    const input = makeLadderInput({
      snapshot: makeSnapshot({
        reviews: [makeReview({ commitOid: "oid-head" })],
      }),
    });
    expect(shouldRequestAtMergeTime(input)).toBe(false);
  });
});

describe("Session dedup: a request fires at most once per session", () => {
  it("suppresses warmup once already requested this session", () => {
    expect(
      shouldRequestWarmup(makeLadderInput({ sessionRequested: true })),
    ).toBe(false);
  });

  it("suppresses approval request once already requested this session", () => {
    const input = makeLadderInput({
      review: ReviewState.Approved,
      sessionRequested: true,
    });
    expect(shouldRequestAtApproval(input)).toBe(false);
  });

  it("suppresses merge-time request once already requested this session", () => {
    expect(
      shouldRequestAtMergeTime(makeLadderInput({ sessionRequested: true })),
    ).toBe(false);
  });
});

describe("shouldRequestCopilot dispatches by event", () => {
  it("routes Warmup to the warmup predicate", () => {
    expect(
      shouldRequestCopilot(CopilotRequestEvent.Warmup, makeLadderInput()),
    ).toBe(true);
  });

  it("routes MergeTime to the merge-time predicate", () => {
    expect(
      shouldRequestCopilot(CopilotRequestEvent.MergeTime, makeLadderInput()),
    ).toBe(true);
  });

  it("routes Approval to the approval predicate", () => {
    const input = makeLadderInput({ review: ReviewState.Approved });
    expect(shouldRequestCopilot(CopilotRequestEvent.Approval, input)).toBe(
      true,
    );
  });
});
