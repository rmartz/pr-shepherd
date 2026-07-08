import { RunStatus, type WorkflowRun } from "@/db/schemas";
import type { RunListRow } from "@/store";

// Mock-run fixtures for the Run List stories and tests — pure data, no store or
// Firestore, per the "stories never depend on Firestore" convention.

export function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "owner/repo",
    prNumber: 1,
    prTitle: "Add a thing",
    status: RunStatus.Running,
    childRunIds: [],
    context: {},
    createdAt: 1_000_000,
    updatedAt: 1_045_000,
    metrics: {
      totalClaudeMs: 42_000,
      totalActiveMs: 8_000,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
    ...overrides,
  };
}

export function makeRunRow(
  run: Partial<WorkflowRun> = {},
  depth = 0,
): RunListRow {
  return { run: makeRun(run), depth };
}
