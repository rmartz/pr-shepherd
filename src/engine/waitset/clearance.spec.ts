import { describe, it, expect } from "vitest";
import {
  WaitKind,
  isCiCleared,
  isCopilotCleared,
  isWaitCleared,
} from "./clearance";
import { makePrSnapshot } from "./waitset-tests/fixtures";

// A passing GitHub Actions suite.
const passedSuite = {
  appName: "GitHub Actions",
  workflowName: "CI",
  status: "COMPLETED",
  conclusion: "SUCCESS",
};

// An Actions suite still executing.
const runningSuite = {
  appName: "GitHub Actions",
  workflowName: "CI",
  status: "IN_PROGRESS",
  conclusion: undefined,
};

// A pending non-Actions (Vercel) commit status — must never clear CI on its own.
const pendingVercel = {
  context: "vercel",
  state: "PENDING",
  description: undefined,
  targetUrl: undefined,
};

describe("CI clearance requires both no running Actions suite and a landed verdict", () => {
  it("clears when an Actions suite has landed a passing verdict", () => {
    const snapshot = makePrSnapshot({ checkSuites: [passedSuite] });
    expect(isCiCleared(snapshot)).toBe(true);
  });

  it("clears on a landed failing verdict (failing is a verdict, not a non-result)", () => {
    const snapshot = makePrSnapshot({
      checkSuites: [{ ...passedSuite, conclusion: "FAILURE" }],
    });
    expect(isCiCleared(snapshot)).toBe(true);
  });

  it("does not clear while an Actions suite is still running", () => {
    const snapshot = makePrSnapshot({
      checkSuites: [passedSuite, runningSuite],
    });
    expect(isCiCleared(snapshot)).toBe(false);
  });

  it("does not clear when only a non-Actions status is pending and no Actions verdict has landed", () => {
    const snapshot = makePrSnapshot({
      checkSuites: [runningSuite],
      commitStatuses: [pendingVercel],
    });
    expect(isCiCleared(snapshot)).toBe(false);
  });

  it("does not clear when an Actions run is waiting for maintainer authorization", () => {
    const snapshot = makePrSnapshot({
      checkSuites: [
        { ...passedSuite, status: "WAITING", conclusion: undefined },
      ],
    });
    expect(isCiCleared(snapshot)).toBe(false);
  });
});

describe("Copilot clearance requires an actual review verdict", () => {
  it("clears once Copilot has resolved with no open threads", () => {
    const snapshot = makePrSnapshot({
      reviews: [
        {
          id: 1,
          author: "copilot-pull-request-reviewer[bot]",
          state: "COMMENTED",
          submittedAt: "2026-06-15T00:00:00Z",
          commitOid: "oid-head",
          body: "Looks good.",
        },
      ],
    });
    expect(isCopilotCleared(snapshot)).toBe(true);
  });

  it("does not clear while Copilot review is only requested (no response yet)", () => {
    const snapshot = makePrSnapshot();
    expect(isCopilotCleared(snapshot)).toBe(false);
  });
});

describe("isWaitCleared dispatches to the predicate for the wait kind", () => {
  it("routes a CI wait through the CI predicate", () => {
    const snapshot = makePrSnapshot({ checkSuites: [passedSuite] });
    expect(isWaitCleared(WaitKind.Ci, snapshot)).toBe(true);
  });

  it("routes a Copilot wait through the Copilot predicate", () => {
    const snapshot = makePrSnapshot({ checkSuites: [passedSuite] });
    // CI has landed but Copilot has not responded — a CI-cleared snapshot must
    // not clear a Copilot wait.
    expect(isWaitCleared(WaitKind.CopilotReview, snapshot)).toBe(false);
  });
});
