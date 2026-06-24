import { describe, it, expect, vi, afterEach } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { StepStatus, StepType, type StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";
import type { DaemonHandle } from "@/engine/bootstrap";
import { gracefulShutdown, installShutdownHandlers } from "./shutdown";

function makeRunningStep(id: string): StepInstance {
  return {
    id,
    runId: "run-1",
    stepDefinitionId: "review",
    stepType: StepType.ClaudeSkill,
    status: StepStatus.Running,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1,
    startedAt: 2,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
  };
}

interface FakeHandle {
  handle: DaemonHandle;
  db: Db;
  schedulerStop: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeHandle(): FakeHandle {
  const db = createInMemoryDb();
  const schedulerStop = vi.fn();
  const stop = vi.fn();
  const handle = {
    db,
    scheduler: { stop: schedulerStop },
    stop,
  } as unknown as DaemonHandle;
  return { handle, db, schedulerStop, stop };
}

describe("gracefulShutdown halts the scheduler and tears down", () => {
  it("exits 0 immediately when no steps are in flight", async () => {
    const { handle, schedulerStop, stop } = makeHandle();
    const onExit = vi.fn();

    const result = await gracefulShutdown(handle, {
      onExit,
      drainTimeoutMs: 0,
    });

    expect(schedulerStop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(result.drained).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(onExit).toHaveBeenCalledWith(0);
  });
});

describe("gracefulShutdown drains in-flight steps", () => {
  it("waits for a running step to settle within the grace period, then exits 0", async () => {
    const { handle, db, stop } = makeHandle();
    await db.create(Collections.stepInstances, makeRunningStep("s1"));
    let clock = 0;
    const onExit = vi.fn();
    // The injected sleep advances the clock AND completes the step, simulating
    // the runner settling it mid-drain.
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
      await db.update(Collections.stepInstances, "s1", {
        status: StepStatus.Completed,
      });
    });

    const result = await gracefulShutdown(handle, {
      drainTimeoutMs: 1000,
      pollIntervalMs: 250,
      now: () => clock,
      sleep,
      onExit,
    });

    expect(sleep).toHaveBeenCalledOnce();
    expect(result.drained).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("hard-exits non-zero when the grace period elapses with steps still running", async () => {
    const { handle, db, stop } = makeHandle();
    await db.create(Collections.stepInstances, makeRunningStep("s1"));
    let clock = 0;
    const onExit = vi.fn();
    // Step never settles; sleep only advances the clock until the deadline.
    const sleep = vi.fn((ms: number) => {
      clock += ms;
      return Promise.resolve();
    });

    const result = await gracefulShutdown(handle, {
      drainTimeoutMs: 1000,
      pollIntervalMs: 250,
      now: () => clock,
      sleep,
      onExit,
    });

    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(onExit).toHaveBeenCalledWith(1);
    // Teardown still runs even on a non-clean drain.
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("installShutdownHandlers wires SIGTERM/SIGINT once", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("runs shutdown once on SIGTERM and ignores a repeat signal", async () => {
    const { handle, schedulerStop } = makeHandle();
    const onExit = vi.fn();
    cleanup = installShutdownHandlers(handle, { onExit, drainTimeoutMs: 0 });

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(schedulerStop).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("cleanup removes the listeners so later signals are ignored", async () => {
    const { handle, schedulerStop } = makeHandle();
    const onExit = vi.fn();
    installShutdownHandlers(handle, { onExit, drainTimeoutMs: 0 })();

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(schedulerStop).not.toHaveBeenCalled();
  });
});
