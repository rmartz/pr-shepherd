import { describe, it, expect } from "vitest";
import { createStepExecutorRuntime } from "@/engine/runner";
import { Collections } from "@/db/collections";
import { createWaitExternalExecutor } from "../waitExternal";
import {
  makeFakeProcess,
  makeSpawnFn,
  seedRun,
  seedStep,
  makeDb,
} from "./fixtures";

// ---------------------------------------------------------------------------
// createWaitExternalExecutor — output on success
// ---------------------------------------------------------------------------

describe("createWaitExternalExecutor returns output passed: true on success", () => {
  it("resolves with output containing passed: true", async () => {
    const db = makeDb();
    await seedRun(db);
    const step = await seedStep(db);

    const proc = makeFakeProcess();
    const executor = createWaitExternalExecutor(db, {
      spawn: makeSpawnFn(proc),
    });

    const execPromise = executor(step, createStepExecutorRuntime(db, step));
    // Allow the executor to pass through await db.update() and register
    // close listeners on the subprocess before emitting.
    await Promise.resolve();
    await Promise.resolve();
    proc.emitClose(0);
    const result = await execPromise;
    expect(result.output["passed"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createWaitExternalExecutor — failure output
// ---------------------------------------------------------------------------

describe("createWaitExternalExecutor writes failure output before throwing", () => {
  it("sets output { passed: false, reason: timeout } on step record before throwing for exit 1", async () => {
    const db = makeDb();
    await seedRun(db);
    const step = await seedStep(db);

    const proc = makeFakeProcess();
    const executor = createWaitExternalExecutor(db, {
      spawn: makeSpawnFn(proc),
    });

    const execPromise = executor(step, createStepExecutorRuntime(db, step));
    // Allow the executor to pass through await db.update() and register
    // close listeners on the subprocess before emitting.
    await Promise.resolve();
    await Promise.resolve();
    proc.emitClose(1);
    await expect(execPromise).rejects.toThrow("timeout");

    const final = await db.get(Collections.stepInstances, step.id);
    expect(final?.output).toEqual({ passed: false, reason: "timeout" });
  });

  it("sets output { passed: false, reason: error } on step record before throwing for exit 2", async () => {
    const db = makeDb();
    await seedRun(db);
    const step = await seedStep(db);

    const proc = makeFakeProcess();
    const executor = createWaitExternalExecutor(db, {
      spawn: makeSpawnFn(proc),
    });

    const execPromise = executor(step, createStepExecutorRuntime(db, step));
    // Allow the executor to pass through await db.update() and register
    // close listeners on the subprocess before emitting.
    await Promise.resolve();
    await Promise.resolve();
    proc.emitClose(2);
    await expect(execPromise).rejects.toThrow("error");

    const final = await db.get(Collections.stepInstances, step.id);
    expect(final?.output).toEqual({ passed: false, reason: "error" });
  });
});
