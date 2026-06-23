import { describe, it, expect } from "vitest";
import {
  actualCopilotReviewCoversHead,
  hasActualCopilotReview,
  isCopilotRefusalOnly,
} from "../coverage";
import {
  assessCopilotMergeWait,
  CopilotWaitOutcome,
  DEFAULT_COPILOT_WAIT_CAP_MS,
} from "../mergeWait";
import { makeIssueComment, makeReview, makeSnapshot } from "./fixtures";

const REFUSAL = "Copilot wasn't able to review any files in this pull request.";

describe("Refusal vs review: a refusal is not an actual review", () => {
  it("treats a Copilot refusal review as not an actual review", () => {
    const snap = makeSnapshot({ reviews: [makeReview({ body: REFUSAL })] });
    expect(hasActualCopilotReview(snap)).toBe(false);
  });

  it("treats a non-refusal Copilot review as an actual review", () => {
    const snap = makeSnapshot({
      reviews: [makeReview({ body: "Nit: rename." })],
    });
    expect(hasActualCopilotReview(snap)).toBe(true);
  });

  it("does not count a refusal as covering HEAD", () => {
    const snap = makeSnapshot({
      reviews: [makeReview({ body: REFUSAL, commitOid: "oid-head" })],
    });
    expect(actualCopilotReviewCoversHead(snap)).toBe(false);
  });

  it("counts a refusal-only PR (review or comment) as refusal-only", () => {
    const reviewRefusal = makeSnapshot({
      reviews: [makeReview({ body: REFUSAL })],
    });
    const commentRefusal = makeSnapshot({
      issueComments: [makeIssueComment({ body: REFUSAL })],
    });
    expect(isCopilotRefusalOnly(reviewRefusal)).toBe(true);
    expect(isCopilotRefusalOnly(commentRefusal)).toBe(true);
  });

  it("is not refusal-only once an actual review exists", () => {
    const snap = makeSnapshot({
      reviews: [
        makeReview({ body: REFUSAL }),
        makeReview({ id: 2, body: "ok" }),
      ],
    });
    expect(isCopilotRefusalOnly(snap)).toBe(false);
  });
});

describe("Event B wait: a refusal/outage clears the wait but is not a review", () => {
  it("proceeds (advances) on a refusal even while within the window", () => {
    const snap = makeSnapshot({ reviews: [makeReview({ body: REFUSAL })] });
    const outcome = assessCopilotMergeWait({
      snapshot: snap,
      hasOpenCopilotFindings: false,
      elapsedMs: 0,
      capMs: DEFAULT_COPILOT_WAIT_CAP_MS,
    });
    expect(outcome).toBe(CopilotWaitOutcome.Proceed);
  });
});

describe("Event B wait: bounded — findings defer, none/cap proceeds", () => {
  it("waits while within the window and Copilot has not responded", () => {
    const outcome = assessCopilotMergeWait({
      snapshot: makeSnapshot(),
      hasOpenCopilotFindings: false,
      elapsedMs: 1_000,
      capMs: DEFAULT_COPILOT_WAIT_CAP_MS,
    });
    expect(outcome).toBe(CopilotWaitOutcome.Wait);
  });

  it("proceeds once the cap is exceeded with no response", () => {
    const outcome = assessCopilotMergeWait({
      snapshot: makeSnapshot(),
      hasOpenCopilotFindings: false,
      elapsedMs: DEFAULT_COPILOT_WAIT_CAP_MS,
      capMs: DEFAULT_COPILOT_WAIT_CAP_MS,
    });
    expect(outcome).toBe(CopilotWaitOutcome.Proceed);
  });

  it("defers when an actual review covering HEAD has open findings", () => {
    const snap = makeSnapshot({
      reviews: [makeReview({ body: "Bug here.", commitOid: "oid-head" })],
    });
    const outcome = assessCopilotMergeWait({
      snapshot: snap,
      hasOpenCopilotFindings: true,
      elapsedMs: 0,
      capMs: DEFAULT_COPILOT_WAIT_CAP_MS,
    });
    expect(outcome).toBe(CopilotWaitOutcome.Defer);
  });

  it("proceeds when a review covering HEAD has no open findings", () => {
    const snap = makeSnapshot({
      reviews: [makeReview({ body: "LGTM.", commitOid: "oid-head" })],
    });
    const outcome = assessCopilotMergeWait({
      snapshot: snap,
      hasOpenCopilotFindings: false,
      elapsedMs: 0,
      capMs: DEFAULT_COPILOT_WAIT_CAP_MS,
    });
    expect(outcome).toBe(CopilotWaitOutcome.Proceed);
  });
});
