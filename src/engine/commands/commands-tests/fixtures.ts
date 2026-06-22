import {
  CommandStatus,
  CommandType,
  RunStatus,
  StepStatus,
  StepType,
  type Command,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";

// Shared fixture generators for the commands listener tests. Per the testing
// conventions, each `make{Domain}()` returns a fully-valid document that
// `*Schema.parse` accepts, with overrides for the fields a given test controls.

export function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "cmd-1",
    type: CommandType.PauseRun,
    payload: { runId: "run-1" },
    status: CommandStatus.Pending,
    createdAt: 1000,
    ...overrides,
  };
}

export function makeWorkflowRun(
  overrides: Partial<WorkflowRun> = {},
): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "owner/repo-a",
    prNumber: 7,
    prTitle: "test pr",
    status: RunStatus.Running,
    paused: false,
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

export function makeStepInstance(
  overrides: Partial<StepInstance> = {},
): StepInstance {
  return {
    id: "step-1",
    runId: "run-1",
    stepDefinitionId: "step-def-a",
    stepType: StepType.ClaudeSkill,
    status: StepStatus.Failed,
    input: {},
    output: {},
    logs: [],
    retryCount: 2,
    maxRetries: 3,
    error: "boom",
    createdAt: 1000,
    completedAt: 2000,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
    ...overrides,
  };
}
