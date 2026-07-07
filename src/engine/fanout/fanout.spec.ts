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
import { createRunner } from "@/engine/runner";
import { dispatchAndAdvance } from "@/engine/execution/executionTick";
import { spawnChildSteps, type FanOutChildSpec } from "./fanout";

// ---------------------------------------------------------------------------
// Tests for the scatter half of fan-out (#280): `spawnChildSteps` persisting
// linked child steps, plus the runner parking a `suspended` parent in `waiting`
// rather than completing it. The join (gather half) is covered in join.spec.ts.
// ---------------------------------------------------------------------------

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
    status: StepStatus.Queued,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1000,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
    ...overrides,
  };
}

const specs: FanOutChildSpec[] = [
  {
    stepType: StepType.GithubApi,
    stepDefinitionId: "batch",
    input: { action: "add_label", label: "bug" },
  },
  {
    stepType: StepType.GithubApi,
    stepDefinitionId: "batch",
    input: { action: "add_comment", body: "hi" },
    maxRetries: 5,
  },
];

describe("spawnChildSteps persists linked child steps", () => {
  it("creates one pending child per spec, linked to the parent in spawn order", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    let n = 0;
    const ids = await spawnChildSteps(db, makeParent(), specs, {
      newId: () => `child-${(n += 1)}`,
      now: () => 4000,
    });

    expect(ids).toEqual(["child-1", "child-2"]);
    const children = await db.list(Collections.stepInstances, {
      parentStepId: "parent-1",
    });
    expect(children).toHaveLength(2);
    const byId = new Map(children.map((c) => [c.id, c]));
    expect(byId.get("child-1")).toMatchObject({
      runId: "run-1",
      parentStepId: "parent-1",
      status: StepStatus.Pending,
      input: { action: "add_label", label: "bug" },
      maxRetries: 3,
      createdAt: 4000,
    });
    expect(byId.get("child-2")).toMatchObject({
      status: StepStatus.Pending,
      input: { action: "add_comment", body: "hi" },
      maxRetries: 5,
      // Strictly increasing so spawn order is recoverable at join time.
      createdAt: 4001,
    });
  });

  it("throws rather than spawn a childless fan-out", async () => {
    const db = createInMemoryDb();
    await expect(spawnChildSteps(db, makeParent(), [])).rejects.toThrow(
      /zero children/,
    );
  });
});

describe("the runner parks a suspended fan-out parent in waiting", () => {
  it("leaves the parent waiting (not completed) after the executor suspends", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    await db.create(Collections.stepInstances, makeParent());

    let n = 0;
    const runner = createRunner(db, {
      [StepType.GithubApi]: async (step) => {
        await spawnChildSteps(db, step, specs, {
          newId: () => `child-${(n += 1)}`,
          now: () => 4000,
        });
        return { output: {}, suspended: true };
      },
    });
    await runner.dispatch(makeParent());

    const parent = await db.get(Collections.stepInstances, "parent-1");
    expect(parent?.status).toBe(StepStatus.Waiting);
    expect(parent?.waitingAt).toBeDefined();
    // Output is NOT merged/written on suspension — it stays the seeded empty.
    expect(parent?.output).toEqual({});
    const children = await db.list(Collections.stepInstances, {
      parentStepId: "parent-1",
    });
    expect(children.map((c) => c.status)).toEqual([
      StepStatus.Pending,
      StepStatus.Pending,
    ]);
  });
});

describe("dispatchAndAdvance does not route fan-out children", () => {
  it("dispatches children through the full execution path, parent stays waiting with no spurious successors", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    await db.create(
      Collections.stepInstances,
      makeParent({ status: StepStatus.Queued }),
    );

    let n = 0;
    // Parent executor: spawns children and suspends. Child executor: completes normally.
    const runner = createRunner(db, {
      [StepType.GithubApi]: async (step) => {
        if (step.parentStepId === undefined) {
          await spawnChildSteps(db, step, specs, {
            newId: () => `child-${(n += 1)}`,
            now: () => 4000,
          });
          return { output: {}, suspended: true };
        }
        return { output: { done: true } };
      },
    });
    const deps = {
      db,
      runner,
      // getGraph is never reached for children (guarded by parentStepId check).
      getGraph: (): undefined => undefined,
    };

    // Dispatch the parent: it suspends and spawns children.
    await dispatchAndAdvance(makeParent({ status: StepStatus.Queued }), deps);
    const parentAfterSuspend = await db.get(
      Collections.stepInstances,
      "parent-1",
    );
    expect(parentAfterSuspend?.status).toBe(StepStatus.Waiting);

    // Dispatch each child through dispatchAndAdvance (the real execution path).
    const children = await db.list(Collections.stepInstances, {
      parentStepId: "parent-1",
    });
    expect(children).toHaveLength(2);
    for (const child of children) {
      await dispatchAndAdvance(child, deps);
    }

    // Parent must still be waiting — children completing does not route the parent.
    const parentAfterChildren = await db.get(
      Collections.stepInstances,
      "parent-1",
    );
    expect(parentAfterChildren?.status).toBe(StepStatus.Waiting);

    // No spurious successor steps were created by dispatching children.
    // Only parent + 2 children exist; routing a child would have created a 4th.
    const allChildren = await db.list(Collections.stepInstances, {
      parentStepId: "parent-1",
    });
    expect(allChildren).toHaveLength(2);
    expect(allChildren.every((c) => c.status === StepStatus.Completed)).toBe(
      true,
    );
  });
});
