import { describe, it, expect } from "vitest";
import { ReviewState } from "@/engine/derivation";
import {
  shouldRequestAtApproval,
  shouldRequestAtMergeTime,
  shouldRequestWarmup,
} from "../requestLadder";
import { makeLadderInput } from "./fixtures";

describe("Dependabot PRs are skipped at every event", () => {
  it("never warms up a Dependabot PR", () => {
    expect(shouldRequestWarmup(makeLadderInput({ isDependabot: true }))).toBe(
      false,
    );
  });

  it("never requests at approval for a Dependabot PR", () => {
    const input = makeLadderInput({
      isDependabot: true,
      review: ReviewState.Approved,
    });
    expect(shouldRequestAtApproval(input)).toBe(false);
  });

  it("never requests at merge-time for a Dependabot PR", () => {
    expect(
      shouldRequestAtMergeTime(makeLadderInput({ isDependabot: true })),
    ).toBe(false);
  });
});

describe("Interior fix-review cycles do not request Copilot", () => {
  it("does not warm up inside an interior fix-review cycle", () => {
    expect(
      shouldRequestWarmup(makeLadderInput({ inInteriorFixReview: true })),
    ).toBe(false);
  });

  it("does not request at approval inside an interior fix-review cycle", () => {
    const input = makeLadderInput({
      inInteriorFixReview: true,
      review: ReviewState.Approved,
    });
    expect(shouldRequestAtApproval(input)).toBe(false);
  });

  it("does not request at merge-time inside an interior fix-review cycle", () => {
    expect(
      shouldRequestAtMergeTime(makeLadderInput({ inInteriorFixReview: true })),
    ).toBe(false);
  });
});
