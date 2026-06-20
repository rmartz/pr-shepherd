import { describe, expect, it } from "vitest";

import { Action } from "../actions";
import { MergePriority, selectMergeCandidate } from "../mergeCandidate";
import { makeCandidate } from "./fixtures";

describe("selectMergeCandidate() — eligibility", () => {
  it("returns undefined for an empty candidate set", () => {
    expect(selectMergeCandidate([])).toBeUndefined();
  });

  it("returns undefined when no candidate's action is MERGE", () => {
    const candidates = [
      makeCandidate({ prNumber: 1, action: Action.Review }),
      makeCandidate({ prNumber: 2, action: Action.FixReview }),
      makeCandidate({ prNumber: 3, action: Action.WaitCi }),
    ];

    expect(selectMergeCandidate(candidates)).toBeUndefined();
  });

  it("ignores non-MERGE candidates even when they out-rank the eligible one", () => {
    // A higher-priority hotfix that is NOT merge-eligible must not win over the
    // lone MERGE candidate — only `Action.Merge` PRs are arbitrated.
    const winner = makeCandidate({ prNumber: 9, action: Action.Merge });
    const candidates = [
      makeCandidate({
        prNumber: 4,
        action: Action.FixReview,
        priority: MergePriority.Hotfix,
        changedFiles: 99,
      }),
      winner,
    ];

    expect(selectMergeCandidate(candidates)?.prNumber).toBe(9);
  });
});

describe("selectMergeCandidate() — size tie-break", () => {
  it("picks the MERGE candidate with the most files changed", () => {
    const candidates = [
      makeCandidate({ prNumber: 1, changedFiles: 3 }),
      makeCandidate({ prNumber: 2, changedFiles: 11 }),
      makeCandidate({ prNumber: 3, changedFiles: 7 }),
    ];

    expect(selectMergeCandidate(candidates)?.prNumber).toBe(2);
  });
});

describe("selectMergeCandidate() — createdAt tie-break", () => {
  it("breaks an equal file count by oldest createdAt", () => {
    const candidates = [
      makeCandidate({
        prNumber: 1,
        changedFiles: 6,
        createdAt: "2026-06-10T00:00:00Z",
      }),
      makeCandidate({
        prNumber: 2,
        changedFiles: 6,
        createdAt: "2026-06-02T00:00:00Z",
      }),
    ];

    expect(selectMergeCandidate(candidates)?.prNumber).toBe(2);
  });

  it("breaks an equal size and createdAt by lowest PR number for a stable order", () => {
    const candidates = [
      makeCandidate({
        prNumber: 8,
        changedFiles: 4,
        createdAt: "2026-06-05T00:00:00Z",
      }),
      makeCandidate({
        prNumber: 3,
        changedFiles: 4,
        createdAt: "2026-06-05T00:00:00Z",
      }),
    ];

    expect(selectMergeCandidate(candidates)?.prNumber).toBe(3);
  });
});

describe("selectMergeCandidate() — priority ordering", () => {
  it("merges a hotfix ahead of a larger, older normal PR", () => {
    const candidates = [
      makeCandidate({
        prNumber: 1,
        priority: MergePriority.Normal,
        changedFiles: 50,
        createdAt: "2026-05-01T00:00:00Z",
      }),
      makeCandidate({
        prNumber: 2,
        priority: MergePriority.Hotfix,
        changedFiles: 1,
        createdAt: "2026-06-19T00:00:00Z",
      }),
    ];

    expect(selectMergeCandidate(candidates)?.prNumber).toBe(2);
  });

  it("merges a Dependabot-fix ahead of a normal PR but behind a hotfix", () => {
    const candidates = [
      makeCandidate({ prNumber: 1, priority: MergePriority.Normal }),
      makeCandidate({ prNumber: 2, priority: MergePriority.DependabotFix }),
      makeCandidate({ prNumber: 3, priority: MergePriority.Hotfix }),
    ];

    expect(selectMergeCandidate(candidates)?.prNumber).toBe(3);
  });

  it("merges a normal PR ahead of a plain Dependabot PR", () => {
    const candidates = [
      makeCandidate({ prNumber: 1, priority: MergePriority.Dependabot }),
      makeCandidate({ prNumber: 2, priority: MergePriority.Normal }),
    ];

    expect(selectMergeCandidate(candidates)?.prNumber).toBe(2);
  });

  it("applies the size tie-break within the highest-priority class only", () => {
    // Two Dependabot-fixes outrank the large normal PR; among them the larger
    // one wins. The size comparison never crosses the priority boundary.
    const candidates = [
      makeCandidate({
        prNumber: 1,
        priority: MergePriority.Normal,
        changedFiles: 80,
      }),
      makeCandidate({
        prNumber: 2,
        priority: MergePriority.DependabotFix,
        changedFiles: 2,
      }),
      makeCandidate({
        prNumber: 3,
        priority: MergePriority.DependabotFix,
        changedFiles: 9,
      }),
    ];

    expect(selectMergeCandidate(candidates)?.prNumber).toBe(3);
  });
});

describe("selectMergeCandidate() — purity", () => {
  it("does not mutate or reorder the input array", () => {
    const candidates = [
      makeCandidate({ prNumber: 1, changedFiles: 2 }),
      makeCandidate({ prNumber: 2, changedFiles: 9 }),
    ];
    const snapshot = candidates.map((candidate) => candidate.prNumber);

    selectMergeCandidate(candidates);

    expect(candidates.map((candidate) => candidate.prNumber)).toEqual(snapshot);
  });
});
