import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import type { PrSnapshot } from "@/engine/derivation/types";

// Fixture builders for wait-set / liveness / drain-aggregate tests. Each
// returns a minimal valid baseline; tests override only the fields under test
// so a failure points at one cause.

export function makePrSnapshot(
  overrides: Partial<PrSnapshot> = {},
): PrSnapshot {
  return {
    owner: "rmartz",
    repo: "pr-shepherd",
    number: 42,
    title: "Add a thing",
    body: "",
    isDraft: false,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefName: "feat/thing",
    author: "rmartz",
    headOid: "oid-head",
    labels: [],
    commitOids: ["oid-old", "oid-head"],
    checkSuites: [],
    commitStatuses: [],
    reviews: [],
    reviewThreads: [],
    issueComments: [],
    fetchedAt: 1_000_000,
    ...overrides,
  };
}

export function makeWaitStep(
  overrides: Partial<StepInstance> = {},
): StepInstance {
  return {
    id: "step-1",
    runId: "run-1",
    stepDefinitionId: "wait-ci",
    stepType: StepType.WaitExternal,
    status: StepStatus.Waiting,
    input: { kind: "ci", pr: 42 },
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1,
    startedAt: 2,
    waitingAt: 3,
    heartbeatAt: 3,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
    ...overrides,
  };
}

export function makeRunningStep(
  overrides: Partial<StepInstance> = {},
): StepInstance {
  return {
    id: "step-run-1",
    runId: "run-1",
    stepDefinitionId: "review",
    stepType: StepType.ClaudeSkill,
    status: StepStatus.Running,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1,
    startedAt: 100,
    heartbeatAt: 100,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
    ...overrides,
  };
}

export function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "rmartz/pr-shepherd",
    prNumber: 42,
    prTitle: "Add a thing",
    status: RunStatus.Running,
    childRunIds: [],
    context: {},
    createdAt: 1,
    updatedAt: 1,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
    ...overrides,
  };
}
