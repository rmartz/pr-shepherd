import { describe, it, expect, beforeEach } from "vitest";
import { createHostedFirestoreDb } from "../hostedFirestore";
import { Collections } from "../../collections";
import { makeRun } from "../test-fixtures";
import {
  listeners,
  makeFakeAdmin,
  makeFakeClient,
  makeFakeIncrement,
} from "./fakeAdminQuery";

beforeEach(() => {
  listeners.clear();
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 1 (Firestore implementation): increment() wires each
// dotted field path to an atomic increment sentinel via the admin SDK's
// `docRef.update`, so concurrent run-metric rollups never drop a delta (#79).
// The injected `makeIncrement` produces a `FakeIncrement` sentinel the fake
// admin store applies, standing in for `FieldValue.increment`.
// ---------------------------------------------------------------------------
describe("increment() applies atomic deltas to nested admin fields", () => {
  it("adds each delta to the existing nested numeric value", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: makeFakeClient(store),
      makeIncrement: makeFakeIncrement,
    });
    await db.create(
      Collections.workflowRuns,
      makeRun({
        metrics: {
          totalClaudeMs: 100,
          totalActiveMs: 200,
          totalScheduleWaitMs: 300,
          totalExternalWaitMs: 400,
        },
      }),
    );
    await db.increment(Collections.workflowRuns, "run-1", {
      "metrics.totalClaudeMs": 5,
      "metrics.totalActiveMs": 7,
      "metrics.totalScheduleWaitMs": 11,
      "metrics.totalExternalWaitMs": 13,
    });
    const stored = store
      .get("workflowRuns")
      ?.get(encodeURIComponent("run-1")) as { metrics: unknown };
    expect(stored.metrics).toEqual({
      totalClaudeMs: 105,
      totalActiveMs: 207,
      totalScheduleWaitMs: 311,
      totalExternalWaitMs: 413,
    });
  });

  it("sets the optional patch fields in the same update", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: makeFakeClient(store),
      makeIncrement: makeFakeIncrement,
    });
    await db.create(Collections.workflowRuns, makeRun({ updatedAt: 1000 }));
    await db.increment(
      Collections.workflowRuns,
      "run-1",
      { "metrics.totalClaudeMs": 42 },
      { updatedAt: 9999 },
    );
    const stored = store
      .get("workflowRuns")
      ?.get(encodeURIComponent("run-1")) as {
      metrics: { totalClaudeMs: number };
      updatedAt: number;
    };
    expect(stored.metrics.totalClaudeMs).toBe(42);
    expect(stored.updatedAt).toBe(9999);
  });
});
