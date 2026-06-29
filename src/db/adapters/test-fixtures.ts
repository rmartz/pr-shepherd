import { RunStatus, type WorkflowRun } from "../schemas";

// ---------------------------------------------------------------------------
// Shared test fixtures for the db adapter test suites. Centralizing the
// `WorkflowRun` factory here keeps the hosted-Firestore and in-memory adapter
// tests in sync — a schema change to `WorkflowRun` only needs updating once.
// ---------------------------------------------------------------------------

export function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "rmartz/pr-shepherd",
    prNumber: 7,
    prTitle: "test",
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
