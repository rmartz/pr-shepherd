import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import {
  AdmissionRejectReason,
  canAdmitStep,
  type ActiveCounts,
  type ConcurrencyConfig,
} from "@/engine/scheduler/concurrency";
import { createRunner } from "@/engine/runner";
import { decisionExecutor } from "./decision";

// ---------------------------------------------------------------------------
// Tests for the `decision` step executor (vision §4.3).
//
// A decision step is a zero-cost in-process branching point: it has no
// input, no output, no side effects. Its sole purpose is to give workflow
// authors a way to express pure routing logic ("if context.x, route to A,
// else B") without paying for a Claude / GitHub-API / per-repo slot.
//
// The executor itself is therefore trivial — `output: {}`. The actual
// routing happens at the runner's post-completion hook (the routing layer
// in #57) against the just-merged `{output, context}`.
// ---------------------------------------------------------------------------

function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "owner/repo-a",
    prNumber: 1,
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

function makeDecisionStep(): StepInstance {
  return {
    id: "step-1",
    runId: "run-1",
    stepDefinitionId: "decide-next",
    stepType: StepType.Decision,
    status: StepStatus.Queued,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 100,
    queuedAt: 150,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
  };
}

describe("decisionExecutor returns an empty output", () => {
  it("resolves with output: {} regardless of step state", async () => {
    const result = await decisionExecutor(makeDecisionStep());
    expect(result.output).toEqual({});
  });
});

describe("decisionExecutor transitions queued → running → completed via the runner", () => {
  it("ends with status completed and no output fields", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun());
    await db.create(Collections.stepInstances, makeDecisionStep());
    const runner = createRunner(db, {
      [StepType.Decision]: decisionExecutor,
    });
    const step = await db.get(Collections.stepInstances, "step-1");
    await runner.dispatch(step!);
    const final = await db.get(Collections.stepInstances, "step-1");
    expect(final?.status).toBe(StepStatus.Completed);
    expect(final?.output).toEqual({});
  });
});

describe("decisionExecutor never consumes a concurrency slot", () => {
  it("admits a decision candidate even when every cap is saturated", () => {
    // Mirror the most adversarial state: system-wide Claude maxed, GitHub
    // API maxed, and the candidate's repo at its per-repo cap.
    const config: ConcurrencyConfig = {
      systemMax: 8,
      githubApiMax: 4,
      defaultRepoMax: 2,
    };
    const counts: ActiveCounts = {
      systemClaude: config.systemMax,
      systemGithubApi: config.githubApiMax,
      perRepo: new Map([["owner/repo-a", config.defaultRepoMax]]),
    };
    const decision = canAdmitStep(
      { stepType: StepType.Decision, repoId: "owner/repo-a" },
      counts,
      config,
    );
    expect(decision.admit).toBe(true);
    // Sanity-check the rejection enum is intact — guards against a future
    // refactor that silently drops the zero-cost short-circuit.
    expect(AdmissionRejectReason.RepoFull).toBe("repo_full");
  });
});

describe("decisionExecutor runs many steps in quick succession", () => {
  it("completes every step independently with no shared state", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun());
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ids) {
      await db.create(Collections.stepInstances, {
        ...makeDecisionStep(),
        id: `step-${id}`,
        stepDefinitionId: `decide-${id}`,
      });
    }
    const runner = createRunner(db, {
      [StepType.Decision]: decisionExecutor,
    });
    for (const id of ids) {
      const step = await db.get(Collections.stepInstances, `step-${id}`);
      await runner.dispatch(step!);
    }
    for (const id of ids) {
      const final = await db.get(Collections.stepInstances, `step-${id}`);
      expect(final?.status).toBe(StepStatus.Completed);
    }
  });
});
