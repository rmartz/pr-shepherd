import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import type { Db } from "@/db/types";
import {
  runWaitExternal,
  createWaitExternalExecutor,
  WaitExternalInputSchema,
  type WaitProcess,
  type SpawnFn,
} from "./waitExternal";

// ---------------------------------------------------------------------------
// Tests for the wait_external step executor.
//
// The executor wraps ~/.claude/scripts/wait-for-ci.py and
// ~/.claude/scripts/wait-for-copilot-review.py. All subprocess interaction
// is injected via `opts.spawn` so tests run without the real scripts.
//
// Acceptance criteria (vision §4.3, §6):
//   - ci-wait happy path: subprocess exits 0 → completed, passed: true
//   - copilot-review happy path: same with copilot_review kind
//   - timeout exit: subprocess exits 1 → failed, reason: "timeout"
//   - externalWaitMs: metrics bucket populated after waiting
//   - cancellation: SIGTERM sent immediately, SIGKILL after 5 s grace
// ---------------------------------------------------------------------------

// --- Fake subprocess helpers -----------------------------------------------

interface FakeProcess extends WaitProcess {
  emitClose(code: number | null): void;
  emitError(err: Error): void;
  signals: string[];
}

function makeFakeProcess(): FakeProcess {
  const closeListeners: ((code: number | null) => void)[] = [];
  const errorListeners: ((err: Error) => void)[] = [];
  const signals: string[] = [];

  const proc: FakeProcess = {
    signals,
    on(event, listener) {
      if (event === "close") {
        closeListeners.push(listener as (code: number | null) => void);
      } else {
        errorListeners.push(listener as (err: Error) => void);
      }
      return this;
    },
    kill(signal) {
      signals.push(signal);
      return true;
    },
    emitClose(code) {
      for (const l of closeListeners) l(code);
    },
    emitError(err) {
      for (const l of errorListeners) l(err);
    },
  };
  return proc;
}

function makeSpawnFn(proc: FakeProcess): SpawnFn {
  return () => proc;
}

// --- DB seed helpers -------------------------------------------------------

function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "owner/repo-a",
    prNumber: 42,
    prTitle: "test pr",
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

function makeBaseStep(): Omit<StepInstance, "id" | "runId" | "createdAt"> {
  return {
    stepDefinitionId: "wait-ci",
    stepType: StepType.WaitExternal,
    status: StepStatus.Running,
    input: { kind: "ci", pr: 42 },
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
  };
}

async function seedRun(db: Db): Promise<WorkflowRun> {
  const run = makeWorkflowRun();
  await db.create(Collections.workflowRuns, run);
  return run;
}

async function seedStep(
  db: Db,
  overrides: Partial<StepInstance> = {},
): Promise<StepInstance> {
  const step: StepInstance = {
    ...makeBaseStep(),
    id: "step-1",
    runId: "run-1",
    createdAt: 1000,
    startedAt: 1100,
    ...overrides,
  };
  await db.create(Collections.stepInstances, step);
  return step;
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

describe("WaitExternalInputSchema rejects invalid input", () => {
  it("rejects an unknown kind", () => {
    expect(() =>
      WaitExternalInputSchema.parse({ kind: "unknown", pr: 1 }),
    ).toThrow();
  });

  it("rejects a missing pr field", () => {
    expect(() => WaitExternalInputSchema.parse({ kind: "ci" })).toThrow();
  });

  it("accepts ci kind with pr and optional args", () => {
    const parsed = WaitExternalInputSchema.parse({
      kind: "ci",
      pr: 42,
      args: ["--timeout=120"],
    });
    expect(parsed.kind).toBe("ci");
    expect(parsed.pr).toBe(42);
    expect(parsed.args).toEqual(["--timeout=120"]);
  });
});

// ---------------------------------------------------------------------------
// runWaitExternal — ci happy path
// ---------------------------------------------------------------------------

describe("runWaitExternal ci-wait happy path: subprocess exits 0", () => {
  it("resolves with passed: true when the subprocess exits 0", async () => {
    const proc = makeFakeProcess();
    const resultPromise = runWaitExternal(
      { kind: "ci", pr: 42 },
      { spawn: makeSpawnFn(proc) },
    );
    proc.emitClose(0);
    const result = await resultPromise;
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runWaitExternal — copilot_review happy path
// ---------------------------------------------------------------------------

describe("runWaitExternal copilot-review-wait happy path: subprocess exits 0", () => {
  it("resolves with passed: true when the subprocess exits 0", async () => {
    const proc = makeFakeProcess();
    const resultPromise = runWaitExternal(
      { kind: "copilot_review", pr: 7 },
      { spawn: makeSpawnFn(proc) },
    );
    proc.emitClose(0);
    const result = await resultPromise;
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runWaitExternal — timeout exit (exit code 1)
// ---------------------------------------------------------------------------

describe("runWaitExternal timeout exit captured as failed with reason: timeout", () => {
  it("resolves with passed: false and reason: timeout when subprocess exits 1", async () => {
    const proc = makeFakeProcess();
    const resultPromise = runWaitExternal(
      { kind: "ci", pr: 42 },
      { spawn: makeSpawnFn(proc) },
    );
    proc.emitClose(1);
    const result = await resultPromise;
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reason).toBe("timeout");
    }
  });

  it("resolves with passed: false and reason: error for non-zero non-timeout exit code", async () => {
    const proc = makeFakeProcess();
    const resultPromise = runWaitExternal(
      { kind: "ci", pr: 42 },
      { spawn: makeSpawnFn(proc) },
    );
    proc.emitClose(2);
    const result = await resultPromise;
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reason).toBe("error");
    }
  });
});

// ---------------------------------------------------------------------------
// runWaitExternal — cancellation: SIGTERM then SIGKILL after grace period
// ---------------------------------------------------------------------------

describe("runWaitExternal cancellation sends SIGTERM then SIGKILL after grace period", () => {
  it("sends SIGTERM immediately on abort and SIGKILL when the grace timer fires", async () => {
    const proc = makeFakeProcess();
    const controller = new AbortController();

    let graceFn: (() => void) | undefined;
    const fakeSetTimeout = (fn: () => void) => {
      graceFn = fn;
    };

    const resultPromise = runWaitExternal(
      { kind: "ci", pr: 42 },
      {
        spawn: makeSpawnFn(proc),
        signal: controller.signal,
        setTimeout: fakeSetTimeout,
      },
    );

    // Trigger cancel — SIGTERM should be sent synchronously.
    controller.abort();
    expect(proc.signals).toContain("SIGTERM");

    // Grace timer fires → SIGKILL.
    expect(graceFn).toBeDefined();
    graceFn!();
    expect(proc.signals).toContain("SIGKILL");

    // Subprocess eventually exits (killed).
    proc.emitClose(null);
    const result = await resultPromise;
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createWaitExternalExecutor — DB transitions
// ---------------------------------------------------------------------------

describe("createWaitExternalExecutor transitions running → waiting immediately", () => {
  it("sets status to waiting and records waitingAt before the subprocess completes", async () => {
    const db = createInMemoryDb();
    await seedRun(db);
    const step = await seedStep(db);

    const proc = makeFakeProcess();
    const executor = createWaitExternalExecutor(db, {
      spawn: makeSpawnFn(proc),
    });

    // Start the executor but do not await it yet.
    const execPromise = executor(step);

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
    const db = createInMemoryDb();
    await seedRun(db);
    const step = await seedStep(db);

    const proc = makeFakeProcess();
    const executor = createWaitExternalExecutor(db, {
      spawn: makeSpawnFn(proc),
    });

    const execPromise = executor(step);
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

// ---------------------------------------------------------------------------
// createWaitExternalExecutor — output on success
// ---------------------------------------------------------------------------

describe("createWaitExternalExecutor returns output passed: true on success", () => {
  it("resolves with output containing passed: true", async () => {
    const db = createInMemoryDb();
    await seedRun(db);
    const step = await seedStep(db);

    const proc = makeFakeProcess();
    const executor = createWaitExternalExecutor(db, {
      spawn: makeSpawnFn(proc),
    });

    const execPromise = executor(step);
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
    const db = createInMemoryDb();
    await seedRun(db);
    const step = await seedStep(db);

    const proc = makeFakeProcess();
    const executor = createWaitExternalExecutor(db, {
      spawn: makeSpawnFn(proc),
    });

    const execPromise = executor(step);
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
    const db = createInMemoryDb();
    await seedRun(db);
    const step = await seedStep(db);

    const proc = makeFakeProcess();
    const executor = createWaitExternalExecutor(db, {
      spawn: makeSpawnFn(proc),
    });

    const execPromise = executor(step);
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
