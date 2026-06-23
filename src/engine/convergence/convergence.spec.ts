import { describe, it, expect } from "vitest";
import { SkillOutcome, type SkillOutcomeRecord } from "@/engine/outcome";
import {
  ConvergenceAction,
  ConvergenceVerdict,
  durableReviewCount,
  resolveConvergence,
  shouldAssessProgress,
} from "./convergence";

function outcome(skill: string): SkillOutcomeRecord {
  return {
    skill,
    skillVersion: "1",
    gitHash: "abc123",
    outcome: SkillOutcome.SoftReject,
    runId: "run-1",
    stepInstanceId: "step-1",
    headSha: "sha-1",
    timestamp: "2026-06-23T00:00:00Z",
  };
}

describe("durableReviewCount counts review markers only", () => {
  it("counts review outcomes and ignores other skills", () => {
    const outcomes = [
      outcome("review"),
      outcome("fix_review"),
      outcome("review"),
      outcome("merge"),
    ];
    expect(durableReviewCount(outcomes)).toBe(2);
  });
});

describe("shouldAssessProgress fires on the durable review cadence", () => {
  it("never reflects at zero reviews", () => {
    expect(shouldAssessProgress(0)).toBe(false);
  });

  it("reflects every third review by default", () => {
    expect(shouldAssessProgress(1)).toBe(false);
    expect(shouldAssessProgress(2)).toBe(false);
    expect(shouldAssessProgress(3)).toBe(true);
    expect(shouldAssessProgress(4)).toBe(false);
    expect(shouldAssessProgress(6)).toBe(true);
  });

  it("honors a custom cadence", () => {
    expect(shouldAssessProgress(2, { everyNReviews: 2 })).toBe(true);
    expect(shouldAssessProgress(3, { everyNReviews: 2 })).toBe(false);
  });
});

describe("resolveConvergence escalates only flappers", () => {
  it("escalates a flapping loop", () => {
    expect(resolveConvergence(ConvergenceVerdict.Flapping)).toBe(
      ConvergenceAction.Escalate,
    );
  });

  it("continues a converging loop", () => {
    expect(resolveConvergence(ConvergenceVerdict.Converging)).toBe(
      ConvergenceAction.Continue,
    );
  });
});
