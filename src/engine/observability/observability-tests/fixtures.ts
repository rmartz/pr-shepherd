import { EventType, RunStatus, type EventRecord, type WorkflowRun } from "@/db";

// Test fixtures for the self-observability subsystem (#109). Defaults are
// deliberately benign so a test that wants an anomaly must opt into it by
// overriding the relevant field — keeping each test's intent explicit.

export function makeEventRecord(
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    id: "event-1",
    runId: "run-1",
    repo: "owner/repo",
    prNumber: 42,
    eventType: EventType.StepStarted,
    attempts: 1,
    logs: [],
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
    repo: "owner/repo",
    prNumber: 42,
    prTitle: "Add a feature",
    status: RunStatus.Completed,
    childRunIds: [],
    context: {},
    createdAt: 1000,
    updatedAt: 2000,
    completedAt: 2000,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
    ...overrides,
  };
}
