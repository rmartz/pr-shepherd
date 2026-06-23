import { describe, it, expect } from "vitest";
import { createStepExecutorRuntime } from "@/engine/runner";
import { Collections } from "@/db/collections";
import { StepStatus } from "@/db/schemas";
import { createWaitExternalExecutor } from "../waitExternal";
import {
  makeFakeProcess,
  makeSpawnFn,
  seedRun,
  seedStep,
  makeDb,
} from "./fixtures";

// ---------------------------------------------------------------------------
// createWaitExternalExecutor — DB lifecycle transitions
// ---------------------------------------------------------------------------

describe("createWaitExternalExecutor transitions running → waiting immediately", () => {
  it("sets status to waiting and records waitingAt before the subprocess completes", async () => {
    const db = makeDb();
    await seedRun(db);
    const step = await seedStep(db);

    const proc = makeFakeProcess();
    const executor = createWaitExternalExecutor(db, {
      spawn: makeSpawnFn(proc),
    });

    // Start the executor but do not await it yet.
    const execPromise = executor(step, createStepExecutorRuntime(db, step));

    // Yield to the microtask queue so the executor can reach its first
    // await (the db.update for status: waiting).
    await Promise.resolve();
    await Promise.resolve();

    const inFlight = await db.get(Collections.stepInstances, step.id);
    expect(inFlight?.status).toBe(StepStatus.Waiting);
    expect(inFlight?.waitingAt).toBeGreaterThan(0);

    // Let the subprocess complete so the executor settles.
    proc.emitClose(0);
    await execPromise;
  });
});

// ---------------------------------------------------------------------------
// createWaitExternalExecutor — externalWaitMs metric
// ---------------------------------------------------------------------------

describe("createWaitExternalExecutor populates externalWaitMs metric", () => {
  it("sets metrics.externalWaitMs to a non-negative value after completion", async () => {
    const db = makeDb();
    await seedRun(db);
    const step = await seedStep(db);

    const proc = makeFakeProcess();
    const executor = createWaitExternalExecutor(db, {
      spawn: makeSpawnFn(proc),
    });

    const execPromise = executor(step, createStepExecutorRuntime(db, step));
    // Allow the executor to pass through await db.update() and enter
    // runWaitExternal so the close listener is registered before we emit.
    await Promise.resolve();
    await Promise.resolve();
    proc.emitClose(0);
    await execPromise;

    const final = await db.get(Collections.stepInstances, step.id);
    expect(final?.metrics.externalWaitMs).toBeGreaterThanOrEqual(0);
  });
});
