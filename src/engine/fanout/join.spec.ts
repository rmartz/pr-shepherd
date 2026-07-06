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
import { runJoinTick, type JoinDeps } from "./join";

// ---------------------------------------------------------------------------
// Tests for the gather half of fan-out (#280): `runJoinTick` resuming a
// `waiting` parent once its children are all terminal, aggregating their
// outputs, completing/failing the parent, and advancing the run. The scatter
// half (`spawnChildSteps` + runner suspend) is covered in fanout.spec.ts.
// ---------------------------------------------------------------------------

// `batch` fans out; on completion it routes to the terminal `finalize` step so
// we can assert the run advanced off the joined parent.
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

function makeParent(overrides: Partial<StepInstance> = {}): StepInstance {
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
    ...overrides,
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

async function seedParentWithChildren(
  db: Db,
  children: StepInstance[],
): Promise<void> {
  await db.create(Collections.workflowRuns, makeRun());
  await db.create(Collections.stepInstances, makeParent());
  for (const child of children) {
    await db.create(Collections.stepInstances, child);
  }
}

const deps = (db: Db): JoinDeps => ({
  db,
  getGraph: (): WorkflowGraph => makeGraph(),
  newId: (): string => "finalize-instance",
  now: (): number => 5000,
});

describe("runJoinTick resumes a fan-out parent whose children are all terminal", () => {
  it("completes the parent with children aggregated in spawn order and advances the run", async () => {
    const db = createInMemoryDb();
    await seedParentWithChildren(db, [
      makeChild({ id: "child-1", createdAt: 4000, output: { ok: 1 } }),
      makeChild({ id: "child-2", createdAt: 4001, output: { ok: 2 } }),
    ]);

    const report = await runJoinTick(deps(db));

    expect(report.joined).toEqual([
      {
        parentStepId: "parent-1",
        status: StepStatus.Completed,
        advance: {
          kind: "advanced",
          nextStepInstanceId: "finalize-instance",
          nextStepDefinitionId: "finalize",
        },
      },
    ]);
    const parent = await db.get(Collections.stepInstances, "parent-1");
    expect(parent?.status).toBe(StepStatus.Completed);
    expect(parent?.output).toEqual({
      children: [
        { index: 0, status: StepStatus.Completed, output: { ok: 1 } },
        { index: 1, status: StepStatus.Completed, output: { ok: 2 } },
      ],
    });
    // The aggregate is merged into the run context, like any completion.
    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.context).toMatchObject({
      children: [
        { index: 0, status: StepStatus.Completed, output: { ok: 1 } },
        { index: 1, status: StepStatus.Completed, output: { ok: 2 } },
      ],
    });
    // Routing proceeded: the next step was seeded pending.
    const next = await db.get(Collections.stepInstances, "finalize-instance");
    expect(next?.status).toBe(StepStatus.Pending);
  });

  it("fails the parent and does not advance when any child failed", async () => {
    const db = createInMemoryDb();
    await seedParentWithChildren(db, [
      makeChild({
        id: "child-1",
        createdAt: 4000,
        status: StepStatus.Completed,
      }),
      makeChild({
        id: "child-2",
        createdAt: 4001,
        status: StepStatus.Failed,
        error: "boom",
      }),
    ]);

    const report = await runJoinTick(deps(db));

    expect(report.joined).toEqual([
      { parentStepId: "parent-1", status: StepStatus.Failed },
    ]);
    const parent = await db.get(Collections.stepInstances, "parent-1");
    expect(parent?.status).toBe(StepStatus.Failed);
    // A failed parent does not route onward — no successor step exists.
    const next = await db.get(Collections.stepInstances, "finalize-instance");
    expect(next).toBeUndefined();
  });
});

describe("runJoinTick leaves a parent alone until its children finish", () => {
  it("does not join while any child is still non-terminal", async () => {
    const db = createInMemoryDb();
    await seedParentWithChildren(db, [
      makeChild({ id: "child-1", status: StepStatus.Completed }),
      makeChild({ id: "child-2", status: StepStatus.Running }),
    ]);

    const report = await runJoinTick(deps(db));

    expect(report.joined).toEqual([]);
    const parent = await db.get(Collections.stepInstances, "parent-1");
    expect(parent?.status).toBe(StepStatus.Waiting);
  });

  it("ignores a waiting step that has no children (an external wait_* step)", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    await db.create(
      Collections.stepInstances,
      makeParent({ id: "waiter", stepType: StepType.WaitExternal }),
    );

    const report = await runJoinTick(deps(db));

    expect(report.joined).toEqual([]);
    const waiter = await db.get(Collections.stepInstances, "waiter");
    expect(waiter?.status).toBe(StepStatus.Waiting);
  });
});

describe("runJoinTick derives join state from persisted children each tick", () => {
  it("re-runs safely after a completed join without re-joining or double-advancing", async () => {
    const db = createInMemoryDb();
    await seedParentWithChildren(db, [
      makeChild({ id: "child-1", createdAt: 4000 }),
      makeChild({ id: "child-2", createdAt: 4001 }),
    ]);

    // A restart replays the tick against the same persisted state.
    const first = await runJoinTick(deps(db));
    const second = await runJoinTick(deps(db));

    expect(first.joined).toHaveLength(1);
    // The parent is no longer `waiting`, so the second tick finds nothing to do.
    expect(second.joined).toEqual([]);
    const parent = await db.get(Collections.stepInstances, "parent-1");
    expect(parent?.status).toBe(StepStatus.Completed);
  });
});
