import { describe, it, expect } from "vitest";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import { selectRunListRows, selectRunSteps, selectStep } from "./selectors";

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
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
    ...overrides,
  };
}

function makeStep(overrides: Partial<StepInstance> = {}): StepInstance {
  return {
    id: "step-1",
    runId: "run-1",
    stepDefinitionId: "derive",
    stepType: StepType.ClaudeSkill,
    status: StepStatus.Pending,
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

function runsState(runs: WorkflowRun[]): { runs: Record<string, WorkflowRun> } {
  return { runs: Object.fromEntries(runs.map((run) => [run.id, run])) };
}

function stepsState(steps: StepInstance[]): {
  steps: Record<string, StepInstance>;
} {
  return { steps: Object.fromEntries(steps.map((step) => [step.id, step])) };
}

describe("selectRunListRows returns indented rows, top-level newest-first", () => {
  it("orders top-level runs newest-first with children nested at depth+1", () => {
    // Two top-level runs (older `top-old`, newer `top-new`); `top-old` has a
    // child. Insertion order is deliberately not the expected order.
    const rows = selectRunListRows(
      runsState([
        makeRun({ id: "top-old", createdAt: 100 }),
        makeRun({ id: "child", parentRunId: "top-old", createdAt: 150 }),
        makeRun({ id: "top-new", createdAt: 200 }),
      ]),
    );

    expect(rows).toEqual([
      { run: expect.objectContaining({ id: "top-new" }), depth: 0 },
      { run: expect.objectContaining({ id: "top-old" }), depth: 0 },
      { run: expect.objectContaining({ id: "child" }), depth: 1 },
    ]);
  });
});

describe("selectRunSteps returns one run's steps in timeline order", () => {
  it("filters to the run and orders by createdAt ascending", () => {
    const steps = selectRunSteps(
      stepsState([
        makeStep({ id: "s2", runId: "run-a", createdAt: 200 }),
        makeStep({ id: "s1", runId: "run-a", createdAt: 100 }),
        makeStep({ id: "other", runId: "run-b", createdAt: 150 }),
      ]),
      "run-a",
    );

    expect(steps.map((step) => step.id)).toEqual(["s1", "s2"]);
  });
});

describe("selectStep looks up a single step by id", () => {
  it("returns the step when present and undefined when absent", () => {
    const state = stepsState([makeStep({ id: "s1" })]);
    expect(selectStep(state, "s1")?.id).toBe("s1");
    expect(selectStep(state, "missing")).toBeUndefined();
  });
});
