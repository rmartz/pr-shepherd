import { describe, it, expect } from "vitest";
import {
  MetaDocSchema,
  RepositorySchema,
  WorkflowRunSchema,
  StepInstanceSchema,
  WorkflowDefinitionSchema,
  RunStatus,
  StepStatus,
  StepType,
} from "./index";

describe("MetaDocSchema round-trip and rejection", () => {
  const valid = {
    id: "workflowRuns",
    schemaVersion: 3,
    updatedAt: 1716700000000,
  };

  it("parses a representative valid meta document", () => {
    const parsed = MetaDocSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it("rejects a meta document with an unknown field", () => {
    const withExtra = { ...valid, unknownField: "extra" };
    expect(() => MetaDocSchema.parse(withExtra)).toThrow();
  });

  it("rejects a meta document with a negative schemaVersion", () => {
    expect(() =>
      MetaDocSchema.parse({ ...valid, schemaVersion: -1 }),
    ).toThrow();
  });

  it("rejects a meta document with schemaVersion 0 to match the runner invariant", () => {
    // The migrations runner never stamps 0 (validateMigrations rejects
    // versions < 1) and treats absence of a meta doc as "nothing applied
    // yet". Allowing 0 here would let a rogue write create a doc that
    // readCurrentVersion would treat identically to "no doc", causing
    // the runner to re-apply every migration.
    expect(() => MetaDocSchema.parse({ ...valid, schemaVersion: 0 })).toThrow();
  });

  it("accepts a meta document with schemaVersion 1 (the minimum valid)", () => {
    const parsed = MetaDocSchema.parse({ ...valid, schemaVersion: 1 });
    expect(parsed.schemaVersion).toBe(1);
  });
});

describe("RepositorySchema round-trip and rejection", () => {
  const valid = {
    id: "rmartz/pr-shepherd",
    owner: "rmartz",
    name: "pr-shepherd",
    enabled: true,
    workflowMap: { "dependabot[bot]": "dependabot-pr", "*": "base-pr" },
    concurrencyMax: 2,
    createdAt: 1716700000000,
  };

  it("parses a representative valid repository", () => {
    const parsed = RepositorySchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it("rejects a repository missing the required owner field", () => {
    const invalid: Record<string, unknown> = { ...valid };
    delete invalid["owner"];
    expect(() => RepositorySchema.parse(invalid)).toThrow();
  });

  it("rejects a repository with an unknown field", () => {
    const withExtra = { ...valid, unknownField: "extra" };
    expect(() => RepositorySchema.parse(withExtra)).toThrow();
  });
});

describe("WorkflowRunSchema round-trip and rejection", () => {
  const valid = {
    id: "run-abc-123",
    workflowId: "base-pr",
    workflowVersion: 4,
    repo: "rmartz/pr-shepherd",
    prNumber: 42,
    prTitle: "feat: add zod schemas",
    status: RunStatus.Running,
    parentRunId: undefined,
    childRunIds: [],
    context: { lastVerdict: "approved" },
    currentStepId: "review",
    createdAt: 1716700000000,
    updatedAt: 1716700001000,
    completedAt: undefined,
    metrics: {
      totalClaudeMs: 1234,
      totalActiveMs: 4321,
      totalScheduleWaitMs: 100,
      totalExternalWaitMs: 200,
    },
  };

  it("parses a representative valid workflow run", () => {
    const parsed = WorkflowRunSchema.parse(valid);
    expect(parsed.status).toBe(RunStatus.Running);
    expect(parsed.metrics.totalClaudeMs).toBe(1234);
  });

  it("rejects a workflow run with an unknown status enum value", () => {
    const invalid = { ...valid, status: "exploded" };
    expect(() => WorkflowRunSchema.parse(invalid)).toThrow();
  });

  it("rejects a workflow run with an unknown field", () => {
    const withExtra = { ...valid, unknownField: "extra" };
    expect(() => WorkflowRunSchema.parse(withExtra)).toThrow();
  });
});

describe("StepInstanceSchema round-trip and rejection", () => {
  const valid = {
    id: "step-xyz-789",
    runId: "run-abc-123",
    stepDefinitionId: "review",
    stepType: StepType.ClaudeSkill,
    status: StepStatus.Running,
    input: { pr: 42 },
    output: {},
    logs: ["claude invoked", "claude returned"],
    logFile: undefined,
    retryCount: 0,
    maxRetries: 3,
    error: undefined,
    createdAt: 1716700000000,
    queuedAt: 1716700000500,
    startedAt: 1716700001000,
    waitingAt: undefined,
    completedAt: undefined,
    heartbeatAt: 1716700001500,
    metrics: {
      claudeMs: 1500,
      activeMs: 2000,
      scheduleWaitMs: 500,
      externalWaitMs: 0,
    },
  };

  it("parses a representative valid step instance", () => {
    const parsed = StepInstanceSchema.parse(valid);
    expect(parsed.stepType).toBe(StepType.ClaudeSkill);
    expect(parsed.status).toBe(StepStatus.Running);
  });

  it("rejects a step instance with an unknown stepType enum value", () => {
    const invalid = { ...valid, stepType: "telepathy" };
    expect(() => StepInstanceSchema.parse(invalid)).toThrow();
  });

  it("rejects a step instance with an unknown field", () => {
    const withExtra = { ...valid, unknownField: "extra" };
    expect(() => StepInstanceSchema.parse(withExtra)).toThrow();
  });
});

describe("WorkflowDefinitionSchema round-trip and rejection", () => {
  const valid = {
    id: "base-pr@4",
    workflowId: "base-pr",
    version: 4,
    source: "id: base-pr\nversion: 4\nsteps: []\n",
    createdAt: 1716700000000,
  };

  it("parses a representative valid workflow definition", () => {
    const parsed = WorkflowDefinitionSchema.parse(valid);
    expect(parsed.version).toBe(4);
  });

  it("rejects a workflow definition missing the required source field", () => {
    const invalid: Record<string, unknown> = { ...valid };
    delete invalid["source"];
    expect(() => WorkflowDefinitionSchema.parse(invalid)).toThrow();
  });

  it("rejects a workflow definition with an unknown field", () => {
    const withExtra = { ...valid, unknownField: "extra" };
    expect(() => WorkflowDefinitionSchema.parse(withExtra)).toThrow();
  });
});
