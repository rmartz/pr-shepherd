import { describe, it, expect, beforeEach } from "vitest";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import { useDaemonStore } from "./daemonStore";

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

const store = () => useDaemonStore.getState();

beforeEach(() => {
  useDaemonStore.setState({ runs: {}, steps: {} });
});

describe("upsertRun and removeRun", () => {
  it("upserts a run by id, overwriting a prior version", () => {
    store().upsertRun(makeRun({ id: "r1", status: RunStatus.Running }));
    store().upsertRun(makeRun({ id: "r1", status: RunStatus.Completed }));
    expect(store().runs["r1"]?.status).toBe(RunStatus.Completed);
  });

  it("removes a run by id, leaving others", () => {
    store().upsertRun(makeRun({ id: "r1" }));
    store().upsertRun(makeRun({ id: "r2" }));
    store().removeRun("r1");
    expect(store().runs["r1"]).toBeUndefined();
    expect(store().runs["r2"]).toBeDefined();
  });
});

describe("upsertStep and removeStep", () => {
  it("upserts a step by id, overwriting a prior version", () => {
    store().upsertStep(makeStep({ id: "s1", status: StepStatus.Pending }));
    store().upsertStep(makeStep({ id: "s1", status: StepStatus.Completed }));
    expect(store().steps["s1"]?.status).toBe(StepStatus.Completed);
  });

  it("removes a step by id, leaving others", () => {
    store().upsertStep(makeStep({ id: "s1" }));
    store().upsertStep(makeStep({ id: "s2" }));
    store().removeStep("s1");
    expect(store().steps["s1"]).toBeUndefined();
    expect(store().steps["s2"]).toBeDefined();
  });
});

describe("setRuns replaces the whole runs window", () => {
  it("keys the snapshot by id and drops runs absent from it", () => {
    store().upsertRun(makeRun({ id: "stale" }));
    store().setRuns([makeRun({ id: "r1" }), makeRun({ id: "r2" })]);
    expect(Object.keys(store().runs).sort()).toEqual(["r1", "r2"]);
  });
});

describe("setStepsForRun replaces one run's steps only", () => {
  it("drops the run's absent steps but leaves other runs' steps intact", () => {
    store().upsertStep(makeStep({ id: "a1", runId: "run-a" }));
    store().upsertStep(makeStep({ id: "a2", runId: "run-a" }));
    store().upsertStep(makeStep({ id: "b1", runId: "run-b" }));

    store().setStepsForRun("run-a", [makeStep({ id: "a3", runId: "run-a" })]);

    expect(Object.keys(store().steps).sort()).toEqual(["a3", "b1"]);
  });
});
