import { describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { StepStatus } from "@/db/schemas";
import { checkLiveness, watchdogTick, type WatchdogState } from "./liveness";
import { makeRunningStep, makeWaitStep } from "./waitset-tests/fixtures";

describe("a per-action hard timeout force-fails a stuck running step", () => {
  it("fails a running step that has exceeded its hard cap", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.stepInstances,
      makeRunningStep({ id: "s1", startedAt: 1000 }),
    );

    const report = await checkLiveness(db, {
      hardTimeoutMs: 5000,
      stallWarningMs: 60_000,
      nowMs: () => 1000 + 5001,
    });

    expect(report.timedOut).toEqual(["s1"]);
    const settled = await db.get(Collections.stepInstances, "s1");
    expect(settled?.status).toBe(StepStatus.Failed);
    expect(settled?.error).toBe("action_hard_timeout");
  });

  it("leaves a running step within its hard cap untouched", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.stepInstances,
      makeRunningStep({ id: "s1", startedAt: 1000 }),
    );

    const report = await checkLiveness(db, {
      hardTimeoutMs: 5000,
      stallWarningMs: 60_000,
      nowMs: () => 1000 + 4999,
    });

    expect(report.timedOut).toEqual([]);
    const settled = await db.get(Collections.stepInstances, "s1");
    expect(settled?.status).toBe(StepStatus.Running);
  });
});

describe("a per-wait stall warning flags a long wait without failing it", () => {
  it("flags a waiting step past the stall threshold but leaves it waiting", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "w1", waitingAt: 2000 }),
    );

    const report = await checkLiveness(db, {
      hardTimeoutMs: 5_000_000,
      stallWarningMs: 30_000,
      nowMs: () => 2000 + 30_001,
    });

    expect(report.stalled).toEqual(["w1"]);
    const settled = await db.get(Collections.stepInstances, "w1");
    expect(settled?.status).toBe(StepStatus.Waiting);
  });
});

describe("the liveness watchdog force-exits a deadlocked daemon", () => {
  it("exits non-zero when the work set makes no progress within the deadlock window", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.stepInstances,
      makeRunningStep({ id: "s1", startedAt: 0 }),
    );
    const onExit = vi.fn();
    // First tick records the fingerprint at t=0.
    const seed: WatchdogState = { lastFingerprint: "", lastProgressAt: 0 };

    const afterFirst = await watchdogTick(
      db,
      { deadlockTimeoutMs: 10_000, nowMs: () => 0, onExit },
      seed,
    );
    expect(onExit).not.toHaveBeenCalled();

    // Second tick: same fingerprint, deadlock window elapsed → force-exit.
    await watchdogTick(
      db,
      { deadlockTimeoutMs: 10_000, nowMs: () => 10_001, onExit },
      afterFirst,
    );

    expect(onExit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("does not exit while the work set keeps changing", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.stepInstances,
      makeRunningStep({ id: "s1", startedAt: 0 }),
    );
    const onExit = vi.fn();
    const seed: WatchdogState = { lastFingerprint: "", lastProgressAt: 0 };

    const afterFirst = await watchdogTick(
      db,
      { deadlockTimeoutMs: 10_000, nowMs: () => 0, onExit },
      seed,
    );
    // A step transitions between ticks → fingerprint changes → progress.
    await db.update(Collections.stepInstances, "s1", {
      status: StepStatus.Completed,
    });

    const afterSecond = await watchdogTick(
      db,
      { deadlockTimeoutMs: 10_000, nowMs: () => 10_001, onExit },
      afterFirst,
    );

    expect(onExit).not.toHaveBeenCalled();
    expect(afterSecond.lastProgressAt).toBe(10_001);
  });
});
