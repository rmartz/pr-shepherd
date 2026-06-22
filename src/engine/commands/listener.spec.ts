import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { CommandStatus, CommandType, StepStatus } from "@/db/schemas";
import type { Db } from "@/db/types";
import { startCommandListener } from "./listener";
import {
  makeCommand,
  makeStepInstance,
  makeWorkflowRun,
} from "./commands-tests/fixtures";

// ---------------------------------------------------------------------------
// `startCommandListener` subscribes to the `commands` collection and applies
// each pending command to its target, marking the document terminal. These
// tests drive the in-memory adapter's subscribe callback (no real Firestore)
// and use the handle's `drain()` to await the in-flight snapshot.
// ---------------------------------------------------------------------------

async function seedAndDrain(db: Db, seed: () => Promise<void>): Promise<void> {
  const handle = startCommandListener(db);
  await seed();
  await handle.drain();
  handle.stop();
}

describe("commands listener — subscribes and applies pause", () => {
  it("applies a pending pause_run command to the targeted run", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ paused: false }),
    );

    await seedAndDrain(db, async () => {
      await db.create(
        Collections.commands,
        makeCommand({
          type: CommandType.PauseRun,
          payload: { runId: "run-1" },
        }),
      );
    });

    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.paused).toBe(true);
  });
});

describe("commands listener — applies resume", () => {
  it("clears the hold on the targeted run", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ paused: true }),
    );

    await seedAndDrain(db, async () => {
      await db.create(
        Collections.commands,
        makeCommand({
          id: "cmd-resume",
          type: CommandType.ResumeRun,
          payload: { runId: "run-1" },
        }),
      );
    });

    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.paused).toBe(false);
  });
});

describe("commands listener — applies force-retry", () => {
  it("re-enqueues the targeted step as pending", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.stepInstances,
      makeStepInstance({ status: StepStatus.Failed }),
    );

    await seedAndDrain(db, async () => {
      await db.create(
        Collections.commands,
        makeCommand({
          id: "cmd-retry",
          type: CommandType.ForceRetryStep,
          payload: { stepInstanceId: "step-1" },
        }),
      );
    });

    const step = await db.get(Collections.stepInstances, "step-1");
    expect(step?.status).toBe(StepStatus.Pending);
  });
});

describe("commands listener — marks commands handled", () => {
  it("transitions an applied command out of pending to handled", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun());

    await seedAndDrain(db, async () => {
      await db.create(
        Collections.commands,
        makeCommand({
          type: CommandType.PauseRun,
          payload: { runId: "run-1" },
        }),
      );
    });

    const command = await db.get(Collections.commands, "cmd-1");
    expect(command?.status).toBe(CommandStatus.Handled);
  });
});

describe("commands listener — idempotent re-delivery", () => {
  it("applies the effect at most once across repeated snapshots", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ paused: false }),
    );

    // Count how many times the pause effect actually lands by observing
    // workflowRuns updates. A second application would re-write `paused` and
    // bump `updatedAt`, so we assert the run is updated exactly once.
    let runUpdates = 0;
    db.subscribe(Collections.workflowRuns, undefined, () => {
      runUpdates += 1;
    });
    const baselineUpdates = runUpdates;

    const handle = startCommandListener(db);
    await db.create(
      Collections.commands,
      makeCommand({ type: CommandType.PauseRun, payload: { runId: "run-1" } }),
    );
    await handle.drain();

    // Re-deliver the same command id (still pending payload) by re-creating it
    // and forcing another snapshot. The handled-set guard must suppress it.
    await db.create(
      Collections.commands,
      makeCommand({
        type: CommandType.PauseRun,
        payload: { runId: "run-1" },
        status: CommandStatus.Pending,
      }),
    );
    await handle.drain();
    handle.stop();

    expect(runUpdates - baselineUpdates).toBe(1);
  });
});

describe("commands listener — records failures", () => {
  it("marks a malformed payload failed with a recorded error", async () => {
    const db = createInMemoryDb();

    await seedAndDrain(db, async () => {
      await db.create(
        Collections.commands,
        makeCommand({
          id: "cmd-nopayload",
          type: CommandType.PauseRun,
          payload: {},
        }),
      );
    });

    const command = await db.get(Collections.commands, "cmd-nopayload");
    expect(command?.status).toBe(CommandStatus.Failed);
    expect(command?.error).toBeDefined();
  });

  it("marks a command targeting a missing run failed", async () => {
    const db = createInMemoryDb();

    await seedAndDrain(db, async () => {
      await db.create(
        Collections.commands,
        makeCommand({
          id: "cmd-missing",
          type: CommandType.PauseRun,
          payload: { runId: "does-not-exist" },
        }),
      );
    });

    const command = await db.get(Collections.commands, "cmd-missing");
    expect(command?.status).toBe(CommandStatus.Failed);
  });
});
