import { describe, it, expect, vi } from "vitest";
import { Collections } from "@/db/collections";
import { StepStatus, StepType } from "@/db/schemas";
import { runSchedulerTick, startScheduler } from "./loop";
import { AdmissionRejectReason } from "./concurrency";
import {
  makeConfig,
  makeDb,
  seedRun,
  seedPendingStep,
  seedActiveStep,
} from "./scheduler-tests/fixtures";

// ---------------------------------------------------------------------------
// Tests for the scheduler loop. `runSchedulerTick` is the single-pass unit
// the long-running `startScheduler` invokes on the configured cadence. The
// tick reads `pending` stepInstances, derives `ActiveCounts` from `running`
// steps, walks candidates in `createdAt` ASC order, calls `canAdmitStep`
// from #45, and transitions admitted steps to `queued` via `Db.update`.
//
// Active counts come from a Db query each tick rather than a long-lived
// in-process map — the scheduler is restart-safe by construction (vision
// §4.2 acceptance criterion).
// ---------------------------------------------------------------------------

describe("runSchedulerTick on an empty pending set", () => {
  it("returns an empty report and makes no Db writes", async () => {
    const db = makeDb();
    const report = await runSchedulerTick(db, makeConfig());
    expect(report.admitted).toEqual([]);
    expect(report.rejected).toEqual([]);
    expect(report.pendingCount).toBe(0);
  });
});

describe("runSchedulerTick admits a single pending candidate when capacity is available", () => {
  it("transitions one pending step to queued and records it in the report", async () => {
    const db = makeDb();
    const run = await seedRun(db);
    await seedPendingStep(db, {
      id: "step-1",
      runId: run.id,
      createdAt: 1000,
    });
    const report = await runSchedulerTick(db, makeConfig());
    expect(report.admitted).toHaveLength(1);
    expect(report.admitted[0]?.stepInstanceId).toBe("step-1");
    expect(report.rejected).toHaveLength(0);
    expect(report.pendingCount).toBe(1);
    const updated = await db.get(Collections.stepInstances, "step-1");
    expect(updated?.status).toBe(StepStatus.Queued);
    expect(updated?.queuedAt).toBeDefined();
  });
});

describe("runSchedulerTick admits multiple pending candidates in one tick when capacity permits", () => {
  it("transitions all admitted candidates and updates local counts so subsequent candidates see the new state", async () => {
    const db = makeDb();
    const run = await seedRun(db);
    await seedPendingStep(db, {
      id: "step-1",
      runId: run.id,
      createdAt: 1000,
    });
    await seedPendingStep(db, {
      id: "step-2",
      runId: run.id,
      createdAt: 1100,
    });
    const config = makeConfig();
    config.concurrency.defaultRepoMax = 5; // enough for both
    const report = await runSchedulerTick(db, config);
    expect(report.admitted.map((a) => a.stepInstanceId)).toEqual([
      "step-1",
      "step-2",
    ]);
  });

  it("rejects later candidates once the local repo count saturates within a single tick", async () => {
    const db = makeDb();
    const run = await seedRun(db);
    await seedPendingStep(db, {
      id: "step-1",
      runId: run.id,
      createdAt: 1000,
    });
    await seedPendingStep(db, {
      id: "step-2",
      runId: run.id,
      createdAt: 1100,
    });
    await seedPendingStep(db, {
      id: "step-3",
      runId: run.id,
      createdAt: 1200,
    });
    const config = makeConfig();
    config.concurrency.defaultRepoMax = 2; // exactly two slots
    const report = await runSchedulerTick(db, config);
    expect(report.admitted.map((a) => a.stepInstanceId)).toEqual([
      "step-1",
      "step-2",
    ]);
    expect(report.rejected.map((r) => r.stepInstanceId)).toEqual(["step-3"]);
  });
});

describe("Candidates are walked in createdAt ASC order (FIFO across iterations)", () => {
  it("orders by createdAt even when steps were created in DB in a different order", async () => {
    const db = makeDb();
    const run = await seedRun(db);
    // Insert steps in reverse-time order; the scheduler must reorder.
    await seedPendingStep(db, {
      id: "step-late",
      runId: run.id,
      createdAt: 3000,
    });
    await seedPendingStep(db, {
      id: "step-mid",
      runId: run.id,
      createdAt: 2000,
    });
    await seedPendingStep(db, {
      id: "step-early",
      runId: run.id,
      createdAt: 1000,
    });
    const config = makeConfig();
    config.concurrency.defaultRepoMax = 1; // only one fits
    const report = await runSchedulerTick(db, config);
    expect(report.admitted[0]?.stepInstanceId).toBe("step-early");
  });
});

describe("Active counts are derived from a Db query each tick (restart-safe)", () => {
  it("counts existing running steps so already-busy capacity is respected", async () => {
    const db = makeDb();
    const run = await seedRun(db);
    // Seed two running github_api steps — global githubApiMax is 4.
    await seedActiveStep(db, {
      id: "running-1",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 500,
    });
    await seedActiveStep(db, {
      id: "running-2",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 600,
    });
    await seedPendingStep(db, {
      id: "pending-1",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 1000,
    });
    const config = makeConfig();
    config.concurrency.githubApiMax = 3;
    config.concurrency.defaultRepoMax = 5;
    // 2 already running + 1 to admit = 3, which equals the cap — but the
    // admission check is `active < max`, so with 2 active and cap 3, one
    // more admits and the count reaches 3.
    const report = await runSchedulerTick(db, config);
    expect(report.admitted).toHaveLength(1);
  });

  it("rejects a candidate when existing running steps have already saturated the per-repo cap", async () => {
    const db = makeDb();
    const run = await seedRun(db);
    await seedActiveStep(db, {
      id: "running-1",
      runId: run.id,
      stepType: StepType.ClaudeSkill,
      createdAt: 500,
    });
    await seedActiveStep(db, {
      id: "running-2",
      runId: run.id,
      stepType: StepType.ClaudeSkill,
      createdAt: 600,
    });
    await seedPendingStep(db, {
      id: "pending-1",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 1000,
    });
    const config = makeConfig();
    config.concurrency.defaultRepoMax = 2; // exactly the running count
    const report = await runSchedulerTick(db, config);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.decision.admit).toBe(false);
  });

  it("counts waiting wait_external steps against the per-repo cap", async () => {
    const db = makeDb();
    const run = await seedRun(db);
    await seedActiveStep(db, {
      id: "waiting-1",
      runId: run.id,
      stepType: StepType.WaitExternal,
      status: StepStatus.Waiting,
      createdAt: 500,
    });
    await seedPendingStep(db, {
      id: "pending-1",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 1000,
    });
    const config = makeConfig();
    config.concurrency.defaultRepoMax = 1;
    const report = await runSchedulerTick(db, config);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.stepInstanceId).toBe("pending-1");
    expect(report.rejected[0]?.decision).toEqual({
      admit: false,
      reason: AdmissionRejectReason.RepoFull,
    });
  });
});

describe("Rejection reasons are captured in the tick report", () => {
  it("records the AdmissionRejectReason for each rejected candidate", async () => {
    const db = makeDb();
    const run = await seedRun(db);
    await seedPendingStep(db, {
      id: "blocked",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 1000,
    });
    const config = makeConfig();
    config.concurrency.githubApiMax = 0; // nothing can admit
    const report = await runSchedulerTick(db, config);
    expect(report.rejected).toHaveLength(1);
    const rejection = report.rejected[0]?.decision;
    expect(rejection?.admit).toBe(false);
    if (rejection && !rejection.admit) {
      expect(rejection.reason).toBeDefined();
    }
  });
});

describe("runSchedulerTick only fetches workflow runs referenced by in-flight steps", () => {
  it("does not read runs that are not parents of any pending/running/waiting step", async () => {
    const db = makeDb();
    // The relevant run (parent of the pending step) and one unrelated
    // run that should never be read by the tick. We instrument `db.get`
    // to confirm the narrowing.
    const relevantRun = await seedRun(db, { id: "relevant" });
    await seedRun(db, { id: "unrelated" });
    await seedPendingStep(db, {
      id: "step-1",
      runId: relevantRun.id,
      createdAt: 1000,
    });
    const fetchedIds: string[] = [];
    const originalGet = db.get.bind(db);
    db.get = async (coll, id) => {
      if (coll.name === Collections.workflowRuns.name) {
        fetchedIds.push(id);
      }
      return originalGet(coll, id);
    };
    await runSchedulerTick(db, makeConfig());
    expect(fetchedIds).toEqual(["relevant"]);
  });
});

describe("startScheduler runs ticks on the configured cadence and stops cleanly", () => {
  it("invokes runSchedulerTick at the configured interval and stops when requested", async () => {
    const db = makeDb();
    const tickCount = { n: 0 };
    const sleeps: number[] = [];
    // Inject a sleep that resolves immediately and records the requested
    // delay; that lets us assert the cadence without actually waiting.
    // The injected sleep must yield via a macrotask so the test's own
    // `setTimeout(r, 0)` waits below can actually fire — otherwise the
    // loop's microtask chain starves the event loop.
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    // We can't directly mock runSchedulerTick from inside the loop module,
    // but we can observe its effect: each tick on an empty DB returns a
    // report (no admits) and increments the count via a beforeTick hook.
    const handle = startScheduler(db, makeConfig(), {
      intervalMs: 5000,
      sleep,
      onTick: () => {
        tickCount.n++;
      },
    });
    // Yield a few microtasks to let the loop iterate.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    handle.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(tickCount.n).toBeGreaterThan(0);
    expect(sleep).toHaveBeenCalled();
    expect(sleeps[0]).toBe(5000);
  });

  it("survives a thrown error in a tick (logs via onTickError) and keeps running", async () => {
    const db = makeDb();
    const errors: unknown[] = [];
    const sleep = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    let calls = 0;
    const handle = startScheduler(db, makeConfig(), {
      intervalMs: 1,
      sleep,
      onTick: () => {
        calls++;
        if (calls === 1) {
          throw new Error("first-tick boom");
        }
      },
      onTickError: (err) => {
        errors.push(err);
      },
    });
    // Let two ticks fire.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    handle.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
