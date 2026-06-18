import { describe, it, expect } from "vitest";
import { derivePrState } from "../axes";
import { CIState } from "../state-vector";
import { makeCheckSuite, makeCommitStatus, makePrSnapshot } from "./fixtures";

// CIState axis. RUNNING/FAILING are GitHub-Actions-only; a pending non-Actions
// status (Vercel) does not make CI "done"; infra cancels are mutually
// exclusive from real failures; >=2 cancels on the same commit -> retried.

describe("CIState: PASSED when Actions suites all succeed", () => {
  it("is PASSED when the only Actions suite concluded SUCCESS", () => {
    const snap = makePrSnapshot({ checkSuites: [makeCheckSuite()] });
    expect(derivePrState(snap).ci).toBe(CIState.Passed);
  });

  it("is PASSED even when a Vercel commit status is still PENDING", () => {
    const snap = makePrSnapshot({
      checkSuites: [makeCheckSuite()],
      commitStatuses: [makeCommitStatus({ state: "PENDING" })],
    });
    expect(derivePrState(snap).ci).toBe(CIState.Passed);
  });
});

describe("CIState: RUNNING only for in-flight Actions suites", () => {
  it("is RUNNING when an Actions suite is IN_PROGRESS", () => {
    const snap = makePrSnapshot({
      checkSuites: [
        makeCheckSuite({ status: "IN_PROGRESS", conclusion: undefined }),
      ],
    });
    expect(derivePrState(snap).ci).toBe(CIState.Running);
  });

  it("is PASSED, not RUNNING, when only a non-Actions status is PENDING", () => {
    const snap = makePrSnapshot({
      checkSuites: [makeCheckSuite()],
      commitStatuses: [
        makeCommitStatus({ context: "Vercel", state: "PENDING" }),
      ],
    });
    expect(derivePrState(snap).ci).toBe(CIState.Passed);
  });
});

describe("CIState: FAILING for a real Actions failure", () => {
  it("is FAILING when an Actions suite concluded FAILURE", () => {
    const snap = makePrSnapshot({
      checkSuites: [makeCheckSuite({ conclusion: "FAILURE" })],
    });
    expect(derivePrState(snap).ci).toBe(CIState.Failing);
  });

  it("a passing rollup never masks a real Actions failure", () => {
    const snap = makePrSnapshot({
      checkSuites: [
        makeCheckSuite({ workflowName: "CI", conclusion: "FAILURE" }),
        makeCheckSuite({ workflowName: "Lint", conclusion: "SUCCESS" }),
      ],
      commitStatuses: [makeCommitStatus({ state: "SUCCESS" })],
    });
    expect(derivePrState(snap).ci).toBe(CIState.Failing);
  });
});

describe("CIState: infra cancels are distinct from failures", () => {
  it("is CANCELLED for a single CANCELLED Actions suite", () => {
    const snap = makePrSnapshot({
      checkSuites: [makeCheckSuite({ conclusion: "CANCELLED" })],
    });
    expect(derivePrState(snap).ci).toBe(CIState.Cancelled);
  });

  it("treats TIMED_OUT and STARTUP_FAILURE as infra cancels, not FAILING", () => {
    const snap = makePrSnapshot({
      checkSuites: [
        makeCheckSuite({ workflowName: "CI", conclusion: "TIMED_OUT" }),
        makeCheckSuite({
          workflowName: "Build",
          conclusion: "STARTUP_FAILURE",
        }),
      ],
    });
    expect(derivePrState(snap).ci).toBe(CIState.CancelledRetried);
  });

  it("is CANCELLED_RETRIED when >=2 suites cancelled on the same commit", () => {
    const snap = makePrSnapshot({
      checkSuites: [
        makeCheckSuite({ workflowName: "CI", conclusion: "CANCELLED" }),
        makeCheckSuite({ workflowName: "Build", conclusion: "CANCELLED" }),
      ],
    });
    expect(derivePrState(snap).ci).toBe(CIState.CancelledRetried);
  });

  it("a real failure wins over a concurrent infra cancel", () => {
    const snap = makePrSnapshot({
      checkSuites: [
        makeCheckSuite({ workflowName: "CI", conclusion: "FAILURE" }),
        makeCheckSuite({ workflowName: "Build", conclusion: "CANCELLED" }),
      ],
    });
    expect(derivePrState(snap).ci).toBe(CIState.Failing);
  });
});

describe("CIState: NEEDS_AUTH when a suite awaits approval to run", () => {
  it("is NEEDS_AUTH when an Actions suite is ACTION_REQUIRED", () => {
    const snap = makePrSnapshot({
      checkSuites: [
        makeCheckSuite({ status: "COMPLETED", conclusion: "ACTION_REQUIRED" }),
      ],
    });
    expect(derivePrState(snap).ci).toBe(CIState.NeedsAuth);
  });
});
