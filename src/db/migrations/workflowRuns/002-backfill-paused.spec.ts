import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { RunStatus, type WorkflowRun } from "@/db/schemas";
import { backfillPaused } from "./002-backfill-paused";

// The backfill stamps an explicit `paused: false` on runs created before the
// hold flag existed. The in-memory adapter validates on write, so a run with
// no `paused` key is a valid pre-#121 document.

function makeLegacyRun(): WorkflowRun {
  return {
    id: "run-legacy",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "owner/repo",
    prNumber: 1,
    prTitle: "legacy",
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
  };
}

describe("workflowRuns 002 backfill-paused", () => {
  it("stamps paused=false on a run that predates the flag", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeLegacyRun());

    await backfillPaused.up(db);

    const run = await db.get(Collections.workflowRuns, "run-legacy");
    expect(run?.paused).toBe(false);
  });

  it("leaves an already-paused run untouched", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, {
      ...makeLegacyRun(),
      id: "run-held",
      paused: true,
    });

    await backfillPaused.up(db);

    const run = await db.get(Collections.workflowRuns, "run-held");
    expect(run?.paused).toBe(true);
  });
});
