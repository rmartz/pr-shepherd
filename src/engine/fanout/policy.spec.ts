import { describe, it, expect } from "vitest";
import type { WorkflowGraph } from "@/config";
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
import { spawnChildSteps, type FanOutChildSpec } from "./fanout";
import { runJoinTick, type JoinDeps } from "./join";

// ---------------------------------------------------------------------------
// Tests for fan-out child policy (#313): `optional` children never gate the
// join, and a child past its `deadlineAt` is force-terminated as `skipped` so a
// required child's wait is bounded. The base fan-out/fan-in behavior lives in
// fanout.spec.ts / join.spec.ts.
// ---------------------------------------------------------------------------

function makeGraph(): WorkflowGraph {
  return {
    id: "wf-test",
    version: 1,
    source: "",
    steps: [
      {
        id: "batch",
        stepType: StepType.GithubApi,
        input: {},
        routing: [{ condition: "true", next: "finalize" }],
      },
      {
        id: "finalize",
        stepType: StepType.GithubApi,
        input: {},
        routing: [{ condition: "true", next: undefined }],
      },
    ],
  };
}

function makeRun(): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "wf-test",
    workflowVersion: 1,
    repo: "owner/repo",
    prNumber: 7,
    prTitle: "pr",
    status: RunStatus.Running,
    childRunIds: [],
    context: {},
    currentStepId: "parent-1",
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

function makeParent(): StepInstance {
  return {
    id: "parent-1",
    runId: "run-1",
    stepDefinitionId: "batch",
    stepType: StepType.GithubApi,
    status: StepStatus.Waiting,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1000,
    startedAt: 1100,
    waitingAt: 1200,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
  };
}

function makeChild(overrides: Partial<StepInstance> = {}): StepInstance {
  return {
    id: "child-1",
    runId: "run-1",
    parentStepId: "parent-1",
    stepDefinitionId: "batch",
    stepType: StepType.GithubApi,
    status: StepStatus.Completed,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 4000,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
    ...overrides,
  };
}

async function seed(db: Db, children: StepInstance[]): Promise<void> {
  await db.create(Collections.workflowRuns, makeRun());
  await db.create(Collections.stepInstances, makeParent());
  for (const child of children) {
    await db.create(Collections.stepInstances, child);
  }
}

// now = 5000 for deadline comparisons.
const deps = (db: Db): JoinDeps => ({
  db,
  getGraph: (): WorkflowGraph => makeGraph(),
  newId: (): string => "finalize-instance",
  now: (): number => 5000,
});

describe("spawnChildSteps persists per-child policy", () => {
  it("records optional and a spawn-relative deadline on the child", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    const specs: FanOutChildSpec[] = [
      { stepType: StepType.GithubApi, stepDefinitionId: "batch", input: {} },
      {
        stepType: StepType.GithubApi,
        stepDefinitionId: "batch",
        input: {},
        optional: true,
        deadlineMs: 1200,
      },
    ];
    let n = 0;
    await spawnChildSteps(db, makeParent(), specs, {
      newId: () => `c-${(n += 1)}`,
      now: () => 4000,
    });

    const c1 = await db.get(Collections.stepInstances, "c-1");
    const c2 = await db.get(Collections.stepInstances, "c-2");
    // A plain child carries no policy fields.
    expect(c1?.optional).toBeUndefined();
    expect(c1?.deadlineAt).toBeUndefined();
    // The policy child carries optional + an absolute deadline (spawn 4000 + 1200).
    expect(c2?.optional).toBe(true);
    expect(c2?.deadlineAt).toBe(5200);
  });
});

describe("optional children never gate the join", () => {
  it("completes the parent while an optional child is still running", async () => {
    const db = createInMemoryDb();
    await seed(db, [
      makeChild({
        id: "required",
        createdAt: 4000,
        status: StepStatus.Completed,
      }),
      makeChild({
        id: "sidecar",
        createdAt: 4001,
        optional: true,
        status: StepStatus.Running,
      }),
    ]);

    const report = await runJoinTick(deps(db));

    expect(report.joined.map((j) => j.status)).toEqual([StepStatus.Completed]);
    // The optional child is left to finish on its own — not skipped or cancelled.
    const sidecar = await db.get(Collections.stepInstances, "sidecar");
    expect(sidecar?.status).toBe(StepStatus.Running);
  });

  it("ignores an optional child's failure", async () => {
    const db = createInMemoryDb();
    await seed(db, [
      makeChild({
        id: "required",
        createdAt: 4000,
        status: StepStatus.Completed,
      }),
      makeChild({
        id: "sidecar",
        createdAt: 4001,
        optional: true,
        status: StepStatus.Failed,
      }),
    ]);

    const report = await runJoinTick(deps(db));

    expect(report.joined.map((j) => j.status)).toEqual([StepStatus.Completed]);
  });
});

describe("a required child's failure halts the parent", () => {
  it("fails the parent when a required child failed", async () => {
    const db = createInMemoryDb();
    await seed(db, [
      makeChild({ id: "required", createdAt: 4000, status: StepStatus.Failed }),
    ]);

    const report = await runJoinTick(deps(db));

    expect(report.joined).toEqual([
      { parentStepId: "parent-1", status: StepStatus.Failed },
    ]);
    const next = await db.get(Collections.stepInstances, "finalize-instance");
    expect(next).toBeUndefined();
  });
});

describe("a deadline bounds a required child's wait", () => {
  it("skips a non-terminal child past its deadline and lets the parent complete", async () => {
    const db = createInMemoryDb();
    await seed(db, [
      // Still waiting, but its deadline (4000) has passed as of now (5000).
      makeChild({
        id: "required",
        createdAt: 4000,
        status: StepStatus.Waiting,
        deadlineAt: 4000,
      }),
    ]);

    const report = await runJoinTick(deps(db));

    const child = await db.get(Collections.stepInstances, "required");
    expect(child?.status).toBe(StepStatus.Skipped);
    expect(report.joined.map((j) => j.status)).toEqual([StepStatus.Completed]);
  });

  it("rolls child metrics into step and run totals on deadline termination", async () => {
    const db = createInMemoryDb();
    // Child started at 4000, will be force-skipped at now=5000 (deadlineAt=4500).
    await seed(db, [
      makeChild({
        id: "required",
        createdAt: 4000,
        startedAt: 4000,
        status: StepStatus.Running,
        deadlineAt: 4500,
        metrics: {
          claudeMs: 0,
          activeMs: 0,
          scheduleWaitMs: 0,
          externalWaitMs: 0,
        },
      }),
    ]);

    await runJoinTick(deps(db));

    const child = await db.get(Collections.stepInstances, "required");
    // activeMs = elapsed(startedAt=4000, completedAt=5000) = 1000 (GithubApi type)
    expect(child?.metrics.activeMs).toBe(1000);

    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.metrics.totalActiveMs).toBeGreaterThanOrEqual(1000);
  });

  it("does not skip or join before the deadline passes", async () => {
    const db = createInMemoryDb();
    await seed(db, [
      // Deadline (6000) is still in the future relative to now (5000).
      makeChild({
        id: "required",
        createdAt: 4000,
        status: StepStatus.Running,
        deadlineAt: 6000,
      }),
    ]);

    const report = await runJoinTick(deps(db));

    expect(report.joined).toEqual([]);
    const child = await db.get(Collections.stepInstances, "required");
    expect(child?.status).toBe(StepStatus.Running);
    const parent = await db.get(Collections.stepInstances, "parent-1");
    expect(parent?.status).toBe(StepStatus.Waiting);
  });
});
