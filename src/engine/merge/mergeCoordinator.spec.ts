import { describe, it, expect, vi } from "vitest";
import { createMergeCoordinator, MergeOutcome } from "./mergeCoordinator";
import { MergeReadiness } from "./readiness";

function baseAttempt(overrides: {
  headSha?: string;
  revalidate?: () => Promise<MergeReadiness>;
  merge?: () => Promise<void>;
  markForFix?: (reason: MergeReadiness | "merge_error") => Promise<void>;
}) {
  return {
    repo: "owner/repo",
    pr: 7,
    headSha: overrides.headSha ?? "sha-1",
    revalidate:
      overrides.revalidate ?? (() => Promise.resolve(MergeReadiness.Ready)),
    merge: overrides.merge ?? (() => Promise.resolve()),
    markForFix: overrides.markForFix ?? (() => Promise.resolve()),
  };
}

describe("merge coordinator merges a ready candidate", () => {
  it("performs the merge and returns Merged", async () => {
    const merge = vi.fn(() => Promise.resolve());
    const coordinator = createMergeCoordinator();

    const outcome = await coordinator.attemptMerge(baseAttempt({ merge }));

    expect(outcome).toBe(MergeOutcome.Merged);
    expect(merge).toHaveBeenCalledOnce();
    expect(coordinator.isMerging()).toBe(false);
  });
});

describe("merge coordinator is idempotent on (pr, headSha)", () => {
  it("skips a second attempt at an already-merged HEAD without re-merging", async () => {
    const merge = vi.fn(() => Promise.resolve());
    const coordinator = createMergeCoordinator();

    const first = await coordinator.attemptMerge(baseAttempt({ merge }));
    const second = await coordinator.attemptMerge(baseAttempt({ merge }));

    expect(first).toBe(MergeOutcome.Merged);
    expect(second).toBe(MergeOutcome.Skipped);
    expect(merge).toHaveBeenCalledOnce();
  });

  it("allows a merge again once the HEAD advances", async () => {
    const merge = vi.fn(() => Promise.resolve());
    const coordinator = createMergeCoordinator();

    await coordinator.attemptMerge(baseAttempt({ headSha: "sha-1", merge }));
    const next = await coordinator.attemptMerge(
      baseAttempt({ headSha: "sha-2", merge }),
    );

    expect(next).toBe(MergeOutcome.Merged);
    expect(merge).toHaveBeenCalledTimes(2);
  });
});

describe("merge coordinator serializes merges (mutex)", () => {
  it("skips a concurrent attempt while one merge is in flight", async () => {
    const coordinator = createMergeCoordinator();
    let releaseRevalidate!: (r: MergeReadiness) => void;
    const gatedRevalidate = () =>
      new Promise<MergeReadiness>((resolve) => {
        releaseRevalidate = resolve;
      });

    // First attempt parks inside revalidate (mutex held).
    const firstPromise = coordinator.attemptMerge(
      baseAttempt({ revalidate: gatedRevalidate }),
    );
    expect(coordinator.isMerging()).toBe(true);

    // Second attempt arrives mid-flight → skipped by the mutex.
    const second = await coordinator.attemptMerge(
      baseAttempt({ headSha: "sha-other" }),
    );
    expect(second).toBe(MergeOutcome.Skipped);

    releaseRevalidate(MergeReadiness.Ready);
    expect(await firstPromise).toBe(MergeOutcome.Merged);
  });
});

describe("merge coordinator routes by pre-merge readiness", () => {
  it("defers (no merge, no kickback) when CI is still running", async () => {
    const merge = vi.fn(() => Promise.resolve());
    const markForFix = vi.fn(() => Promise.resolve());
    const coordinator = createMergeCoordinator();

    const outcome = await coordinator.attemptMerge(
      baseAttempt({
        revalidate: () => Promise.resolve(MergeReadiness.CiRunning),
        merge,
        markForFix,
      }),
    );

    expect(outcome).toBe(MergeOutcome.Deferred);
    expect(merge).not.toHaveBeenCalled();
    expect(markForFix).not.toHaveBeenCalled();
  });

  it("rejects to fix-review when CI failed", async () => {
    const merge = vi.fn(() => Promise.resolve());
    const markForFix = vi.fn(() => Promise.resolve());
    const coordinator = createMergeCoordinator();

    const outcome = await coordinator.attemptMerge(
      baseAttempt({
        revalidate: () => Promise.resolve(MergeReadiness.CiFailed),
        merge,
        markForFix,
      }),
    );

    expect(outcome).toBe(MergeOutcome.Rejected);
    expect(merge).not.toHaveBeenCalled();
    expect(markForFix).toHaveBeenCalledWith(MergeReadiness.CiFailed);
  });

  it("marks for re-review when the merge attempt errors (no retry in place)", async () => {
    const markForFix = vi.fn(() => Promise.resolve());
    const coordinator = createMergeCoordinator();

    const outcome = await coordinator.attemptMerge(
      baseAttempt({
        merge: () => Promise.reject(new Error("merge failed")),
        markForFix,
      }),
    );

    expect(outcome).toBe(MergeOutcome.Failed);
    expect(markForFix).toHaveBeenCalledWith("merge_error");
    expect(coordinator.isMerging()).toBe(false);
  });
});
