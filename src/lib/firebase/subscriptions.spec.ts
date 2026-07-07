import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import { subscribeToRuns, subscribeToSteps } from "./subscriptions";

// The Firestore client SDK is faked: the query builders return marker objects
// and `onSnapshot` captures the snapshot handler + error handler and returns a
// spy unsubscribe, so each test drives a snapshot emission by hand.
let capturedOnNext: ((snapshot: unknown) => void) | undefined;
let capturedOnError: ((error: unknown) => void) | undefined;
const unsubscribe = vi.fn();

vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, name: string) => ({ collectionName: name }),
  query: (...parts: unknown[]) => ({ queryParts: parts }),
  where: (field: string, op: string, value: unknown) => ({
    where: [field, op, value],
  }),
  orderBy: (field: string, direction: string) => ({
    orderBy: [field, direction],
  }),
  limit: (count: number) => ({ limit: count }),
  onSnapshot: (
    _query: unknown,
    onNext: (snapshot: unknown) => void,
    onError?: (error: unknown) => void,
  ) => {
    capturedOnNext = onNext;
    capturedOnError = onError;
    return unsubscribe;
  },
}));

vi.mock("@/lib/firebase/client", () => ({
  getClientFirestore: () => ({}),
}));

afterEach(() => {
  capturedOnNext = undefined;
  capturedOnError = undefined;
  unsubscribe.mockClear();
});

function snapshotOf(docs: object[]): { docs: { data: () => object }[] } {
  return { docs: docs.map((doc) => ({ data: () => doc })) };
}

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

describe("subscribeToRuns decodes snapshot docs to WorkflowRun", () => {
  it("delivers the decoded runs to onData when a snapshot arrives", () => {
    const onData = vi.fn();
    const returned = subscribeToRuns(onData);

    expect(returned).toBe(unsubscribe);
    capturedOnNext?.(snapshotOf([makeRun({ id: "a" }), makeRun({ id: "b" })]));
    expect(onData).toHaveBeenCalledWith([
      makeRun({ id: "a" }),
      makeRun({ id: "b" }),
    ]);
  });

  it("forwards Firestore errors to onError", () => {
    const onError = vi.fn();
    subscribeToRuns(vi.fn(), onError);

    const error = new Error("permission-denied");
    capturedOnError?.(error);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("routes schema decode errors to onError", () => {
    const onError = vi.fn();
    subscribeToRuns(vi.fn(), onError);

    capturedOnNext?.(snapshotOf([{ invalid: "data" }]));
    expect(onError).toHaveBeenCalled();
  });
});

describe("subscribeToSteps decodes snapshot docs to StepInstance", () => {
  it("delivers the decoded steps to onData when a snapshot arrives", () => {
    const onData = vi.fn();
    subscribeToSteps("run-9", onData);

    capturedOnNext?.(snapshotOf([makeStep({ id: "s1", runId: "run-9" })]));
    expect(onData).toHaveBeenCalledWith([
      makeStep({ id: "s1", runId: "run-9" }),
    ]);
  });

  it("forwards Firestore errors to onError", () => {
    const onError = vi.fn();
    subscribeToSteps("run-9", vi.fn(), onError);

    const error = new Error("permission-denied");
    capturedOnError?.(error);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("routes schema decode errors to onError", () => {
    const onError = vi.fn();
    subscribeToSteps("run-9", vi.fn(), onError);

    capturedOnNext?.(snapshotOf([{ invalid: "data" }]));
    expect(onError).toHaveBeenCalled();
  });
});
