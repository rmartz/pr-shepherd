import { describe, it, expect } from "vitest";
import {
  RepositorySchema,
  WorkflowRunSchema,
  WorkflowRunStatus,
  StepInstanceSchema,
  StepStatus,
  StepType,
  WorkflowDefinitionSchema,
} from "./index.js";

describe("RepositorySchema", () => {
  it("parses a valid repository", () => {
    const input = {
      id: "acme/backend",
      owner: "acme",
      name: "backend",
      enabled: true,
      workflowMap: { "dependabot\\[bot\\]": "dependabot-pr" },
      concurrencyMax: 3,
      createdAt: 1700000000000,
    };
    const result = RepositorySchema.parse(input);
    expect(result.id).toBe("acme/backend");
    expect(result.concurrencyMax).toBe(3);
  });

  it("rejects a missing required field", () => {
    const input = { id: "acme/backend", owner: "acme" };
    expect(() => RepositorySchema.parse(input)).toThrow();
  });

  it("rejects a wrong field type", () => {
    const input = {
      id: "acme/backend",
      owner: "acme",
      name: "backend",
      enabled: "yes",
      workflowMap: {},
      concurrencyMax: 3,
      createdAt: 1700000000000,
    };
    expect(() => RepositorySchema.parse(input)).toThrow();
  });
});

describe("WorkflowRunSchema", () => {
  const validRun = {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "acme/backend",
    prNumber: 42,
    prTitle: "Fix the bug",
    status: WorkflowRunStatus.Running,
    childRunIds: [],
    context: { label: "shepherd" },
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
  };

  it("parses a valid workflow run", () => {
    const result = WorkflowRunSchema.parse(validRun);
    expect(result.id).toBe("run-1");
    expect(result.status).toBe(WorkflowRunStatus.Running);
  });

  it("parses with optional fields present", () => {
    const result = WorkflowRunSchema.parse({
      ...validRun,
      parentRunId: "run-0",
      currentStepId: "review",
      completedAt: 1700000002000,
    });
    expect(result.parentRunId).toBe("run-0");
    expect(result.completedAt).toBe(1700000002000);
  });

  it("rejects an invalid status value", () => {
    expect(() =>
      WorkflowRunSchema.parse({ ...validRun, status: "unknown_status" }),
    ).toThrow();
  });

  it("rejects a missing required field", () => {
    expect(() =>
      WorkflowRunSchema.parse({
        id: "run-1",
        workflowId: "base-pr",
        workflowVersion: 1,
        repo: "acme/backend",
        prTitle: "Fix the bug",
        status: WorkflowRunStatus.Running,
        childRunIds: [],
        context: {},
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        metrics: {
          totalClaudeMs: 0,
          totalActiveMs: 0,
          totalScheduleWaitMs: 0,
          totalExternalWaitMs: 0,
        },
      }),
    ).toThrow();
  });
});

describe("StepInstanceSchema", () => {
  const validStep = {
    id: "step-1",
    runId: "run-1",
    stepDefinitionId: "review",
    stepType: StepType.ClaudeSkill,
    status: StepStatus.Pending,
    input: { context: {} },
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1700000000000,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
  };

  it("parses a valid step instance", () => {
    const result = StepInstanceSchema.parse(validStep);
    expect(result.id).toBe("step-1");
    expect(result.stepType).toBe(StepType.ClaudeSkill);
    expect(result.status).toBe(StepStatus.Pending);
  });

  it("parses with optional timing fields", () => {
    const result = StepInstanceSchema.parse({
      ...validStep,
      queuedAt: 1700000000100,
      startedAt: 1700000000200,
      heartbeatAt: 1700000000300,
    });
    expect(result.startedAt).toBe(1700000000200);
  });

  it("rejects an invalid step type", () => {
    expect(() =>
      StepInstanceSchema.parse({ ...validStep, stepType: "invalid_type" }),
    ).toThrow();
  });

  it("rejects an invalid status value", () => {
    expect(() =>
      StepInstanceSchema.parse({ ...validStep, status: "unknown_status" }),
    ).toThrow();
  });
});

describe("WorkflowDefinitionSchema", () => {
  const validDef = {
    id: "base-pr@1",
    workflowId: "base-pr",
    version: 1,
    content: "id: base-pr\nversion: 1\nsteps: []",
    definition: { id: "base-pr", version: 1, steps: [] },
    createdAt: 1700000000000,
  };

  it("parses a valid workflow definition", () => {
    const result = WorkflowDefinitionSchema.parse(validDef);
    expect(result.id).toBe("base-pr@1");
    expect(result.version).toBe(1);
  });

  it("rejects a missing content field", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        id: "base-pr@1",
        workflowId: "base-pr",
        version: 1,
        definition: { id: "base-pr", version: 1, steps: [] },
        createdAt: 1700000000000,
      }),
    ).toThrow();
  });
});
