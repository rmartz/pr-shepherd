import { describe, it, expect } from "vitest";
import { Collections } from "@/db/collections";
import { StepStatus } from "@/db/schemas";
import type { HeartbeatFailure } from "./heartbeat";
import {
  startScheduler,
  type SchedulerTimers,
  type TriggerSubscription,
} from "./eventScheduler";
import {
  makeConfig,
  makeDb,
  seedRun,
  seedRunningStepWithHeartbeat,
} from "./scheduler-tests/fixtures";

// ---------------------------------------------------------------------------
// Tests for the event-driven scheduler wrapper. `startScheduler` ticks the
// instant a trigger fires (debounced) and on a low-frequency reconciliation
// poll. The single-pass admission logic lives in `runSchedulerTick` and is
// covered by loop.spec.ts — these tests verify the wrapper's triggering,
// coalescing, fallback poll, and shutdown behavior, not admission.
//
// Timers are injected so each one fires deterministically: `fireDelay(ms)`
// invokes every pending timer scheduled with that exact delay, one-shot.
// ---------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  fn: () => void;
  ms: number;
}

function makeFakeTimers() {
  const pending = new Map<number, FakeTimer>();
  let nextId = 1;
  const timers: SchedulerTimers = {
    setTimer: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { id, fn, ms });
      return id;
    },
    clearTimer: (handle) => {
      pending.delete(handle as number);
    },
  };
  const fireDelay = (ms: number): void => {
    for (const timer of [...pending.values()]) {
      if (timer.ms === ms) {
        pending.delete(timer.id);
        timer.fn();
      }
    }
  };
  return { timers, fireDelay };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const noop = (): void => undefined;

const DEBOUNCE_MS = 50;
const RECONCILE_MS = 100_000;

describe("startScheduler ticks when a trigger fires", () => {
  it("runs one tick after a single trigger, once the debounce window elapses", async () => {
    const db = makeDb();
    const { timers, fireDelay } = makeFakeTimers();
    let fire: (() => void) | undefined;
    const capture: TriggerSubscription = (_db, onTrigger) => {
      fire = onTrigger;
      return noop;
    };
    let ticks = 0;
    const handle = startScheduler(db, makeConfig(), {
      reconcileIntervalMs: RECONCILE_MS,
      debounceMs: DEBOUNCE_MS,
      triggers: [capture],
      timers,
      onTick: () => {
        ticks++;
      },
    });

    fire?.();
    fireDelay(DEBOUNCE_MS);
    await flush();
    await handle.stop();

    expect(ticks).toBe(1);
  });
});

describe("startScheduler coalesces a burst of triggers into a single tick", () => {
  it("collapses three rapid triggers within the debounce window to one tick", async () => {
    const db = makeDb();
    const { timers, fireDelay } = makeFakeTimers();
    let fire: (() => void) | undefined;
    const capture: TriggerSubscription = (_db, onTrigger) => {
      fire = onTrigger;
      return noop;
    };
    let ticks = 0;
    const handle = startScheduler(db, makeConfig(), {
      reconcileIntervalMs: RECONCILE_MS,
      debounceMs: DEBOUNCE_MS,
      triggers: [capture],
      timers,
      onTick: () => {
        ticks++;
      },
    });

    fire?.();
    fire?.();
    fire?.();
    fireDelay(DEBOUNCE_MS);
    await flush();
    await handle.stop();

    expect(ticks).toBe(1);
  });
});

describe("startScheduler keeps ticking on the reconciliation poll with no events", () => {
  it("ticks each time the poll fires even when no trigger ever fires", async () => {
    const db = makeDb();
    const { timers, fireDelay } = makeFakeTimers();
    // A trigger source that never emits — only the poll can drive ticks here.
    const silent: TriggerSubscription = () => noop;
    let ticks = 0;
    const handle = startScheduler(db, makeConfig(), {
      reconcileIntervalMs: RECONCILE_MS,
      debounceMs: DEBOUNCE_MS,
      triggers: [silent],
      timers,
      onTick: () => {
        ticks++;
      },
    });

    fireDelay(RECONCILE_MS);
    await flush();
    fireDelay(RECONCILE_MS); // the poll re-arms after each fire
    await flush();
    await handle.stop();

    expect(ticks).toBe(2);
  });
});

describe("startScheduler shuts down gracefully", () => {
  it("detaches every subscription on stop", async () => {
    const db = makeDb();
    const { timers } = makeFakeTimers();
    let unsubscribed = false;
    const capture: TriggerSubscription = () => () => {
      unsubscribed = true;
    };
    const handle = startScheduler(db, makeConfig(), {
      reconcileIntervalMs: RECONCILE_MS,
      triggers: [capture],
      timers,
    });

    await handle.stop();

    expect(unsubscribed).toBe(true);
  });

  it("drains the in-flight tick before stop resolves", async () => {
    const db = makeDb();
    const { timers, fireDelay } = makeFakeTimers();
    let fire: (() => void) | undefined;
    const capture: TriggerSubscription = (_db, onTrigger) => {
      fire = onTrigger;
      return noop;
    };
    let ticks = 0;
    const handle = startScheduler(db, makeConfig(), {
      reconcileIntervalMs: RECONCILE_MS,
      debounceMs: DEBOUNCE_MS,
      triggers: [capture],
      timers,
      onTick: () => {
        ticks++;
      },
    });

    fire?.();
    fireDelay(DEBOUNCE_MS); // starts the tick (in flight, not yet settled)
    await handle.stop(); // must await the in-flight tick

    expect(ticks).toBe(1);
  });
});

describe("startScheduler runs the heartbeat monitor on the reconciliation poll", () => {
  it("reaps a stale running step each time the poll fires", async () => {
    const db = makeDb();
    await seedRun(db);
    // heartbeatAt=0 is far older than the default timeout (intervalSeconds*4),
    // so the sweep marks this step failed.
    await seedRunningStepWithHeartbeat(db, {
      id: "step-dead",
      runId: "run-1",
      heartbeatAt: 0,
    });
    const { timers, fireDelay } = makeFakeTimers();
    const reaped: HeartbeatFailure[][] = [];
    const handle = startScheduler(db, makeConfig(), {
      reconcileIntervalMs: RECONCILE_MS,
      triggers: [() => noop],
      timers,
      onHeartbeat: (failures) => {
        reaped.push(failures);
      },
    });

    fireDelay(RECONCILE_MS);
    await flush();
    await handle.stop();

    expect(reaped).toHaveLength(1);
    expect(reaped[0]?.map((f) => f.stepInstanceId)).toEqual(["step-dead"]);
    const step = await db.get(Collections.stepInstances, "step-dead");
    expect(step?.status).toBe(StepStatus.Failed);
  });

  it("does not run the heartbeat monitor on a debounced admission trigger", async () => {
    const db = makeDb();
    await seedRun(db);
    await seedRunningStepWithHeartbeat(db, {
      id: "step-dead",
      runId: "run-1",
      heartbeatAt: 0,
    });
    const { timers, fireDelay } = makeFakeTimers();
    let fire: (() => void) | undefined;
    const capture: TriggerSubscription = (_db, onTrigger) => {
      fire = onTrigger;
      return noop;
    };
    let sweeps = 0;
    const handle = startScheduler(db, makeConfig(), {
      reconcileIntervalMs: RECONCILE_MS,
      debounceMs: DEBOUNCE_MS,
      triggers: [capture],
      timers,
      onHeartbeat: () => {
        sweeps++;
      },
    });

    fire?.();
    fireDelay(DEBOUNCE_MS);
    await flush();
    await handle.stop();

    expect(sweeps).toBe(0);
    const step = await db.get(Collections.stepInstances, "step-dead");
    expect(step?.status).toBe(StepStatus.Running);
  });
});
