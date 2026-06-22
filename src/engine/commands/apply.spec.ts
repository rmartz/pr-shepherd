import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { CommandType, StepStatus } from "@/db/schemas";
import { applyCommand, CommandApplyError } from "./apply";
import {
  makeCommand,
  makeStepInstance,
  makeWorkflowRun,
} from "./commands-tests/fixtures";

// ---------------------------------------------------------------------------
// `applyCommand` performs one command's effect against the Db. These tests
// drive each command type directly (the listener's orchestration is covered
// separately) to assert the precise run/step mutation produced.
// ---------------------------------------------------------------------------

describe("applyCommand — pause sets a hold", () => {
  it("marks the targeted run paused", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ paused: false }),
    );

    await applyCommand(
      db,
      makeCommand({ type: CommandType.PauseRun, payload: { runId: "run-1" } }),
    );

    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.paused).toBe(true);
  });
});

describe("applyCommand — resume clears the hold", () => {
  it("marks the targeted run not paused", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ paused: true }),
    );

    await applyCommand(
      db,
      makeCommand({ type: CommandType.ResumeRun, payload: { runId: "run-1" } }),
    );

    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.paused).toBe(false);
  });
});

describe("applyCommand — force-retry re-enqueues a step", () => {
  it("resets the step to pending and clears terminal fields", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.stepInstances,
      makeStepInstance({
        status: StepStatus.Failed,
        error: "boom",
        completedAt: 2000,
      }),
    );

    await applyCommand(
      db,
      makeCommand({
        type: CommandType.ForceRetryStep,
        payload: { stepInstanceId: "step-1" },
      }),
    );

    const step = await db.get(Collections.stepInstances, "step-1");
    expect(step?.status).toBe(StepStatus.Pending);
    expect(step?.error).toBeUndefined();
    expect(step?.completedAt).toBeUndefined();
  });

  it("preserves the durable retryCount accounting", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.stepInstances,
      makeStepInstance({ retryCount: 2 }),
    );

    await applyCommand(
      db,
      makeCommand({
        type: CommandType.ForceRetryStep,
        payload: { stepInstanceId: "step-1" },
      }),
    );

    const step = await db.get(Collections.stepInstances, "step-1");
    expect(step?.retryCount).toBe(2);
  });
});

describe("applyCommand — malformed and missing targets fail", () => {
  it("throws when the pause payload omits runId", async () => {
    const db = createInMemoryDb();
    await expect(
      applyCommand(
        db,
        makeCommand({ type: CommandType.PauseRun, payload: {} }),
      ),
    ).rejects.toBeInstanceOf(CommandApplyError);
  });

  it("throws when the targeted run does not exist", async () => {
    const db = createInMemoryDb();
    await expect(
      applyCommand(
        db,
        makeCommand({
          type: CommandType.PauseRun,
          payload: { runId: "missing" },
        }),
      ),
    ).rejects.toBeInstanceOf(CommandApplyError);
  });
});
