import { describe, it, expect } from "vitest";
import { derivePrState } from "../axes";
import {
  CIState,
  CopilotState,
  MergeConflict,
  ThreadState,
} from "../state-vector";
import {
  makeCheckSuite,
  makeIssueComment,
  makePrSnapshot,
  makeReview,
  makeReviewThread,
} from "./fixtures";

describe("MergeConflict: maps raw mergeable verbatim", () => {
  it("is CLEAN for MERGEABLE", () => {
    expect(
      derivePrState(makePrSnapshot({ mergeable: "MERGEABLE" })).conflict,
    ).toBe(MergeConflict.Clean);
  });

  it("is CONFLICTING for CONFLICTING", () => {
    expect(
      derivePrState(makePrSnapshot({ mergeable: "CONFLICTING" })).conflict,
    ).toBe(MergeConflict.Conflicting);
  });

  it("is UNKNOWN for UNKNOWN (non-blocking downstream)", () => {
    expect(
      derivePrState(makePrSnapshot({ mergeable: "UNKNOWN" })).conflict,
    ).toBe(MergeConflict.Unknown);
  });
});

describe("MergeConflict: CONFLICTING is never masked by a green rollup", () => {
  it("reports CONFLICTING on the conflict axis even with passing CI", () => {
    const snap = makePrSnapshot({
      mergeable: "CONFLICTING",
      checkSuites: [makeCheckSuite({ conclusion: "SUCCESS" })],
    });
    const vector = derivePrState(snap);
    expect(vector.conflict).toBe(MergeConflict.Conflicting);
    expect(vector.ci).toBe(CIState.Passed);
  });
});

describe("CopilotState: NONE when Copilot has not reviewed", () => {
  it("is NONE with only human reviews", () => {
    const snap = makePrSnapshot({
      reviews: [makeReview({ author: "rmartz" })],
    });
    expect(derivePrState(snap).copilot).toBe(CopilotState.None);
  });
});

describe("CopilotState: detects authorship by name or login", () => {
  it("is RESOLVED when Copilot reviewed (login contains 'copilot') and no threads are open", () => {
    const snap = makePrSnapshot({
      reviews: [makeReview({ author: "copilot-pull-request-reviewer[bot]" })],
      reviewThreads: [],
    });
    expect(derivePrState(snap).copilot).toBe(CopilotState.Resolved);
  });

  it("is HAS_OPEN_THREADS when a Copilot review left an unresolved thread", () => {
    const snap = makePrSnapshot({
      reviews: [makeReview({ author: "GitHub Copilot" })],
      reviewThreads: [
        makeReviewThread({
          isResolved: false,
          firstCommentAuthor: "copilot[bot]",
        }),
      ],
    });
    expect(derivePrState(snap).copilot).toBe(CopilotState.HasOpenThreads);
  });
});

describe("CopilotState: a refusal is not an actual review", () => {
  it("is AWAITING_REVIEW when the only Copilot activity is a refusal notice", () => {
    const snap = makePrSnapshot({
      reviews: [],
      issueComments: [
        makeIssueComment({
          author: "copilot[bot]",
          body: "Copilot wasn't able to review any files in this pull request.",
        }),
      ],
    });
    expect(derivePrState(snap).copilot).toBe(CopilotState.AwaitingReview);
  });
});

describe("ThreadState: NONE_OPEN vs OPEN", () => {
  it("is NONE_OPEN when all threads are resolved", () => {
    const snap = makePrSnapshot({
      reviewThreads: [makeReviewThread({ isResolved: true })],
    });
    expect(derivePrState(snap).threads).toBe(ThreadState.NoneOpen);
  });

  it("is OPEN when any thread is unresolved", () => {
    const snap = makePrSnapshot({
      reviewThreads: [
        makeReviewThread({ isResolved: true }),
        makeReviewThread({ id: "t2", isResolved: false }),
      ],
    });
    expect(derivePrState(snap).threads).toBe(ThreadState.Open);
  });

  it("ignores outdated unresolved threads", () => {
    const snap = makePrSnapshot({
      reviewThreads: [
        makeReviewThread({ isResolved: false, isOutdated: true }),
      ],
    });
    expect(derivePrState(snap).threads).toBe(ThreadState.NoneOpen);
  });
});
