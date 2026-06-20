import { describe, it, expect } from "vitest";
import { Action } from "../../gates/actions";
import { idempotencyKey, isAlreadyApplied } from "../idempotency";
import { makeIdempotencyTarget } from "./fixtures";

describe("Idempotency keys: keyed on (pr, headSha, action)", () => {
  it("derives a stable key from every target component and the action", () => {
    const target = makeIdempotencyTarget({
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      headSha: "deadbeef",
    });
    expect(idempotencyKey(target, Action.Merge)).toBe(
      "acme:widgets:7:deadbeef:merge",
    );
  });

  it("yields a different key when the HEAD commit changes", () => {
    const a = makeIdempotencyTarget({ headSha: "sha-a" });
    const b = makeIdempotencyTarget({ headSha: "sha-b" });
    expect(idempotencyKey(a, Action.Merge)).not.toBe(
      idempotencyKey(b, Action.Merge),
    );
  });

  it("yields a different key for a different action on the same commit", () => {
    const target = makeIdempotencyTarget();
    expect(idempotencyKey(target, Action.Merge)).not.toBe(
      idempotencyKey(target, Action.FixReview),
    );
  });
});

describe("Idempotency keys: a duplicate execution is a safe no-op", () => {
  it("reports an applied key as already applied (skip the re-execution)", () => {
    const target = makeIdempotencyTarget({ headSha: "merge-sha" });
    const applied = new Set([idempotencyKey(target, Action.Merge)]);
    expect(isAlreadyApplied(target, Action.Merge, applied)).toBe(true);
  });

  it("does not treat a different action on the same commit as applied", () => {
    const target = makeIdempotencyTarget({ headSha: "merge-sha" });
    const applied = new Set([idempotencyKey(target, Action.Merge)]);
    expect(isAlreadyApplied(target, Action.FixReview, applied)).toBe(false);
  });

  it("does not treat the same action on a new commit as applied", () => {
    const oldHead = makeIdempotencyTarget({ headSha: "old-sha" });
    const newHead = makeIdempotencyTarget({ headSha: "new-sha" });
    const applied = new Set([idempotencyKey(oldHead, Action.Merge)]);
    expect(isAlreadyApplied(newHead, Action.Merge, applied)).toBe(false);
  });
});
