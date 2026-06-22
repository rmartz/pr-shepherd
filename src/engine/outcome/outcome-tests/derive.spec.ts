import { describe, expect, it } from "vitest";
import { latestOutcomePerSkill, newCommentSinceOutcome } from "../derive";
import { SkillOutcome } from "../types";
import {
  makeOutcomeComment,
  makeOutcomeRecord,
  makePlainComment,
} from "./fixtures";

describe("Derivation surfaces most recent outcome comment per step", () => {
  it("keeps the newest outcome per skill across many comments", () => {
    const oldReview = makeOutcomeComment(
      makeOutcomeRecord({ outcome: SkillOutcome.SoftReject }),
      { id: 1, createdAt: "2026-06-20T08:00:00Z" },
    );
    const newReview = makeOutcomeComment(
      makeOutcomeRecord({ outcome: SkillOutcome.Approve }),
      { id: 2, createdAt: "2026-06-20T10:00:00Z" },
    );
    const merge = makeOutcomeComment(
      makeOutcomeRecord({ skill: "merge", outcome: SkillOutcome.NoOp }),
      { id: 3, createdAt: "2026-06-20T09:00:00Z" },
    );

    const latest = latestOutcomePerSkill([newReview, oldReview, merge]);

    expect(latest.get("review")?.record.outcome).toBe(SkillOutcome.Approve);
    expect(latest.get("merge")?.record.outcome).toBe(SkillOutcome.NoOp);
  });

  it("picks the newest by timestamp regardless of fetch order", () => {
    const earlier = makeOutcomeComment(
      makeOutcomeRecord({ outcome: SkillOutcome.SoftReject }),
      { id: 1, createdAt: "2026-06-20T08:00:00Z" },
    );
    const later = makeOutcomeComment(
      makeOutcomeRecord({ outcome: SkillOutcome.HardReject }),
      { id: 2, createdAt: "2026-06-20T12:00:00Z" },
    );
    // Provide them newest-first so a naive "last wins" would pick the wrong one.
    const latest = latestOutcomePerSkill([later, earlier]);
    expect(latest.get("review")?.record.outcome).toBe(SkillOutcome.HardReject);
  });

  it("omits skills that posted no outcome comment", () => {
    const latest = latestOutcomePerSkill([makePlainComment()]);
    expect(latest.has("review")).toBe(false);
  });
});

describe("Derivation surfaces new comment since last outcome", () => {
  it("reports a human comment posted after the outcome", () => {
    const outcome = makeOutcomeComment(makeOutcomeRecord(), {
      createdAt: "2026-06-20T10:00:00Z",
    });
    const human = makePlainComment({ createdAt: "2026-06-20T11:00:00Z" });
    expect(newCommentSinceOutcome([outcome, human], "review")).toBe(true);
  });

  it("ignores comments that predate the outcome", () => {
    const human = makePlainComment({ createdAt: "2026-06-20T09:00:00Z" });
    const outcome = makeOutcomeComment(makeOutcomeRecord(), {
      createdAt: "2026-06-20T10:00:00Z",
    });
    expect(newCommentSinceOutcome([human, outcome], "review")).toBe(false);
  });

  it("does not count a later outcome comment as a new external comment", () => {
    const first = makeOutcomeComment(makeOutcomeRecord(), {
      id: 1,
      createdAt: "2026-06-20T10:00:00Z",
    });
    const second = makeOutcomeComment(
      makeOutcomeRecord({ outcome: SkillOutcome.Approve }),
      { id: 2, createdAt: "2026-06-20T11:00:00Z" },
    );
    expect(newCommentSinceOutcome([first, second], "review")).toBe(false);
  });

  it("returns false when the skill has no outcome yet", () => {
    expect(newCommentSinceOutcome([makePlainComment()], "review")).toBe(false);
  });
});
