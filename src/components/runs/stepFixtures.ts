import { StepStatus, StepType, type StepInstance } from "@/db/schemas";

// Mock step-instance fixtures for the Run Detail stories and tests — pure data,
// no store or Firestore, per the "stories never depend on Firestore" convention.

export function makeStep(overrides: Partial<StepInstance> = {}): StepInstance {
  return {
    id: "step-1",
    runId: "run-1",
    stepDefinitionId: "derive_pr_state",
    stepType: StepType.DerivePrState,
    status: StepStatus.Completed,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1_000_000,
    completedAt: 1_002_000,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
    ...overrides,
  };
}
