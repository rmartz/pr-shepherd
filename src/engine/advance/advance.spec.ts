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
import { advanceCompletedStep } from "./advance";

// ---------------------------------------------------------------------------
// Tests for advance-on-completion (#284, part 1). The unit loads the run's
// workflow graph, evaluates the completed step's routing against
// { output, context }, and either seeds the next pending step or finishes the
// run. `evaluateRouting`'s own grammar is covered by #57's tests; these assert
// the wiring — graph lookup → routing → step/run mutation.
// ---------------------------------------------------------------------------

// A two-step graph: `derive` routes to `act` when output.action == 'go', else
// terminates. `act` always terminates. Deliberately non-default so a passing
// test proves routing consumed the output, not an initializer.
function makeGraph(): WorkflowGraph {
  return {
    id: "wf-test",
    version: 1,
    source: "",
    steps: [
      {
        id: "derive",
        stepType: StepType.DerivePrState,
        input: {},
        routing: [
          { condition: "output.action == 'go'", next: "act" },
          { condition: "true", next: undefined },
        ],
      },
      {
        id: "act",
        stepType: StepType.GithubApi,
        input: { actions: "{{ output.actions }}" },
        routing: [{ condition: "true", next: undefined }],
      },
    ],
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
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
    currentStepId: "step-instance-1",
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

function makeStep(overrides: Partial<StepInstance> = {}): StepInstance {
  return {
    id: "step-instance-1",
    runId: "run-1",
    stepDefinitionId: "derive",
    stepType: StepType.DerivePrState,
    status: StepStatus.Completed,
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

async function seed(
  db: Db,
  run: WorkflowRun,
  step: StepInstance,
): Promise<void> {
  await db.create(Collections.workflowRuns, run);
  await db.create(Collections.stepInstances, step);
}

const deps = (db: Db) => ({
  db,
  getGraph: (): WorkflowGraph => makeGraph(),
  newId: (): string => "step-instance-2",
  now: (): number => 5000,
});

describe("advanceCompletedStep creates the routed next step", () => {
  it("seeds the next pending step chosen by the completed step's output", async () => {
    const db = createInMemoryDb();
    const step = makeStep({ output: { action: "go" } });
    await seed(db, makeRun(), step);

    const result = await advanceCompletedStep(step, deps(db));

    expect(result).toEqual({
      kind: "advanced",
      nextStepInstanceId: "step-instance-2",
      nextStepDefinitionId: "act",
    });
    const next = await db.get(Collections.stepInstances, "step-instance-2");
    expect(next).toMatchObject({
      stepDefinitionId: "act",
      stepType: StepType.GithubApi,
      status: StepStatus.Pending,
      input: { actions: "{{ output.actions }}" },
    });
  });

  it("points the run's currentStepId at the new step instance", async () => {
    const db = createInMemoryDb();
    const step = makeStep({ output: { action: "go" } });
    await seed(db, makeRun(), step);

    await advanceCompletedStep(step, deps(db));

    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.currentStepId).toBe("step-instance-2");
  });
});

describe("advanceCompletedStep finishes the run on a terminal route", () => {
  it("marks the run completed and clears currentStepId when no next step is routed", async () => {
    const db = createInMemoryDb();
    // output.action != 'go' → the catch-all terminal rule (next: undefined).
    const step = makeStep({ output: { action: "stop" } });
    await seed(db, makeRun(), step);

    const result = await advanceCompletedStep(step, deps(db));

    expect(result).toEqual({ kind: "completed" });
    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.status).toBe(RunStatus.Completed);
    expect(run?.currentStepId).toBeUndefined();
  });
});

describe("advanceCompletedStep ignores a step that has not completed", () => {
  it("skips a running step without creating a successor", async () => {
    const db = createInMemoryDb();
    const step = makeStep({
      status: StepStatus.Running,
      output: { action: "go" },
    });
    await seed(db, makeRun(), step);

    const result = await advanceCompletedStep(step, deps(db));

    expect(result.kind).toBe("skipped");
    expect(
      await db.get(Collections.stepInstances, "step-instance-2"),
    ).toBeUndefined();
  });
});
