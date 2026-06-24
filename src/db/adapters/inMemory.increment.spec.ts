import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "./inMemory";
import { Collections } from "../collections";
import { RunStatus, type WorkflowRun } from "../schemas";
import type { Db } from "../types";

// ---------------------------------------------------------------------------
// Tests for the atomic `Db.increment` primitive on the in-memory adapter
// (#79). The runner rolls each completed step's metrics delta into the parent
// run via `increment` rather than a read-modify-write `get` + `update`, so the
// adapter must apply concurrent increments without dropping a delta.
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "rmartz/pr-shepherd",
    prNumber: 7,
    prTitle: "test",
    status: RunStatus.Running,
    childRunIds: [],
    context: {},
    createdAt: 1000,
    updatedAt: 1000,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
    ...overrides,
  };
}

async function seedRun(db: Db, overrides: Partial<WorkflowRun> = {}) {
  const run = makeRun(overrides);
  await db.create(Collections.workflowRuns, run);
  return run;
}

describe("increment() adds deltas to nested numeric fields", () => {
  it("adds each delta to the existing nested value", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db, {
      metrics: {
        totalClaudeMs: 100,
        totalActiveMs: 200,
        totalScheduleWaitMs: 300,
        totalExternalWaitMs: 400,
      },
    });
    await db.increment(Collections.workflowRuns, run.id, {
      "metrics.totalClaudeMs": 5,
      "metrics.totalActiveMs": 7,
      "metrics.totalScheduleWaitMs": 11,
      "metrics.totalExternalWaitMs": 13,
    });
    const updated = await db.get(Collections.workflowRuns, run.id);
    expect(updated?.metrics).toEqual({
      totalClaudeMs: 105,
      totalActiveMs: 207,
      totalScheduleWaitMs: 311,
      totalExternalWaitMs: 413,
    });
  });

  it("applies the optional patch alongside the increments", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db, { updatedAt: 1000 });
    await db.increment(
      Collections.workflowRuns,
      run.id,
      { "metrics.totalClaudeMs": 42 },
      { updatedAt: 9999 },
    );
    const updated = await db.get(Collections.workflowRuns, run.id);
    expect(updated?.metrics.totalClaudeMs).toBe(42);
    expect(updated?.updatedAt).toBe(9999);
  });

  it("throws when the document does not exist", async () => {
    const db = createInMemoryDb();
    await expect(
      db.increment(Collections.workflowRuns, "missing", {
        "metrics.totalClaudeMs": 1,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("increment() is atomic under concurrent calls on the same doc", () => {
  it("lands every concurrent delta — no read-modify-write race drops one", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    const calls = 50;
    await Promise.all(
      Array.from({ length: calls }, () =>
        db.increment(Collections.workflowRuns, run.id, {
          "metrics.totalClaudeMs": 1,
          "metrics.totalActiveMs": 2,
        }),
      ),
    );
    const updated = await db.get(Collections.workflowRuns, run.id);
    expect(updated?.metrics.totalClaudeMs).toBe(calls);
    expect(updated?.metrics.totalActiveMs).toBe(calls * 2);
  });
});
