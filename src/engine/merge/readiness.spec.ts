import { describe, it, expect } from "vitest";
import {
  Activity,
  CIState,
  CopilotState,
  DependabotRebaseState,
  HoldState,
  MergeConflict,
  ReviewState,
  ThreadState,
  UATState,
  type PrStateVector,
} from "@/engine/derivation";
import { assessMergeReadiness, MergeReadiness } from "./readiness";
import { needsBranchSync } from "./branchCurrency";

// A merge-ready vector; each test overrides only the axis under test.
function makeState(overrides: Partial<PrStateVector> = {}): PrStateVector {
  return {
    activity: Activity.Active,
    ci: CIState.Passed,
    conflict: MergeConflict.Clean,
    copilot: CopilotState.Resolved,
    dependabotRebase: DependabotRebaseState.None,
    hold: HoldState.None,
    review: ReviewState.Approved,
    threads: ThreadState.NoneOpen,
    uat: UATState.Tested,
    ...overrides,
  };
}

describe("assessMergeReadiness re-validates the volatile axes", () => {
  it("is Ready when clean, passed, and Copilot settled", () => {
    expect(assessMergeReadiness(makeState())).toBe(MergeReadiness.Ready);
  });

  it("distinguishes CI running (defer) from CI failed (fix)", () => {
    expect(assessMergeReadiness(makeState({ ci: CIState.Running }))).toBe(
      MergeReadiness.CiRunning,
    );
    expect(assessMergeReadiness(makeState({ ci: CIState.NeedsAuth }))).toBe(
      MergeReadiness.CiRunning,
    );
    expect(assessMergeReadiness(makeState({ ci: CIState.Failing }))).toBe(
      MergeReadiness.CiFailed,
    );
    expect(assessMergeReadiness(makeState({ ci: CIState.Cancelled }))).toBe(
      MergeReadiness.CiFailed,
    );
  });

  it("flags a conflict", () => {
    expect(
      assessMergeReadiness(makeState({ conflict: MergeConflict.Conflicting })),
    ).toBe(MergeReadiness.Conflicting);
  });

  it("flags Copilot not settled", () => {
    expect(
      assessMergeReadiness(makeState({ copilot: CopilotState.AwaitingReview })),
    ).toBe(MergeReadiness.CopilotPending);
    expect(
      assessMergeReadiness(makeState({ copilot: CopilotState.HasOpenThreads })),
    ).toBe(MergeReadiness.CopilotPending);
  });

  it("returns the fix-worthy blocker ahead of a defer-worthy one", () => {
    // Conflict (→fix) outranks CI still running (→defer).
    expect(
      assessMergeReadiness(
        makeState({ conflict: MergeConflict.Conflicting, ci: CIState.Running }),
      ),
    ).toBe(MergeReadiness.Conflicting);
    // CI failed (→fix) outranks Copilot pending (→defer).
    expect(
      assessMergeReadiness(
        makeState({
          ci: CIState.Failing,
          copilot: CopilotState.AwaitingReview,
        }),
      ),
    ).toBe(MergeReadiness.CiFailed);
  });
});

describe("needsBranchSync — behind-main is not itself a blocker", () => {
  it("never syncs an up-to-date branch", () => {
    expect(
      needsBranchSync({
        behindBy: 0,
        overlappingFiles: 9,
        breakingChange: true,
        lockfilePr: true,
      }),
    ).toBe(false);
  });

  it("does not sync a behind-but-clean branch with no overlap/breaking", () => {
    expect(
      needsBranchSync({
        behindBy: 7,
        overlappingFiles: 0,
        breakingChange: false,
        lockfilePr: false,
      }),
    ).toBe(false);
  });

  it("syncs on overlap, breaking change, or any lockfile drift", () => {
    const behind = { behindBy: 3, breakingChange: false, lockfilePr: false };
    expect(needsBranchSync({ ...behind, overlappingFiles: 2 })).toBe(true);
    expect(
      needsBranchSync({ ...behind, overlappingFiles: 0, breakingChange: true }),
    ).toBe(true);
    expect(
      needsBranchSync({ ...behind, overlappingFiles: 0, lockfilePr: true }),
    ).toBe(true);
  });
});
