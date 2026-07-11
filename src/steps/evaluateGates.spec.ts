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
  Activity,
  CIState,
  CopilotState,
  DependabotRebaseState,
  HoldState,
  MergeConflict,
  ReviewState,
  ThreadState,
  UATState,
  type PrStateVector,
} from "@/engine/derivation";
import { Action, Gate, decide } from "@/engine/gates";
import {
  AdmissionRejectReason,
  canAdmitStep,
  type ActiveCounts,
  type ConcurrencyConfig,
} from "@/engine/scheduler/concurrency";
import { createRunner } from "@/engine/runner";
import { makeNoopRuntime } from "@/engine/runner/runner-tests/fixtures";
import { evaluateGatesExecutor } from "./evaluateGates";
import { GithubActionType } from "./githubApi";

// ---------------------------------------------------------------------------
// Tests for the `evaluate_gates` step executor (Epic 10, #100).
//
// The executor reads the derived `PrStateVector` from its `input.state` (the
// workflow hoists `context.state` into the step input), runs `decide()`, and
// emits `{ action, blockingGate }` so the routing DSL can branch on
// `output.action`. We assert the emitted decision matches `decide()` for
// representative non-default state vectors; `decide`'s own totality and
// per-gate edge cases are covered by #98's tests, not re-tested here.
// ---------------------------------------------------------------------------

function makePrStateVector(
  overrides: Partial<PrStateVector> = {},
): PrStateVector {
  return {
    activity: Activity.Active,
    ci: CIState.Passed,
    conflict: MergeConflict.Clean,
    copilot: CopilotState.Resolved,
    dependabotRebase: DependabotRebaseState.None,
    hold: HoldState.None,
    review: ReviewState.Approved,
    threads: ThreadState.NoneOpen,
    uat: UATState.Tested,
    ...overrides,
  };
}

function makeEvaluateGatesStep(input: Record<string, unknown>): StepInstance {
  return {
    id: "step-1",
    runId: "run-1",
    stepDefinitionId: "evaluate-gates",
    stepType: StepType.Decision,
    status: StepStatus.Queued,
    input,
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

describe("evaluateGatesExecutor emits the action decide() returns", () => {
  it("emits review/code_approved for an unreviewed, otherwise-ready PR", async () => {
    const state = makePrStateVector({ review: ReviewState.Unreviewed });
    const result = await evaluateGatesExecutor(
      makeEvaluateGatesStep({ state }),
      makeNoopRuntime(),
    );
    expect(result.output).toEqual({
      action: Action.Review,
      blockingGate: Gate.CodeApproved,
    });
  });

  it("emits wait_ci/ci_green when CI is still running", async () => {
    const state = makePrStateVector({ ci: CIState.Running });
    const result = await evaluateGatesExecutor(
      makeEvaluateGatesStep({ state }),
      makeNoopRuntime(),
    );
    expect(result.output).toEqual({
      action: Action.WaitCi,
      blockingGate: Gate.CiGreen,
    });
  });

  it("emits merge/merge when every gate is satisfied", async () => {
    const state = makePrStateVector();
    const result = await evaluateGatesExecutor(
      makeEvaluateGatesStep({ state }),
      makeNoopRuntime(),
    );
    expect(result.output).toEqual({
      action: Action.Merge,
      blockingGate: Gate.Merge,
    });
  });
});

describe("evaluateGatesExecutor emits the escalation relabel on an escalate decision", () => {
  it("adds `escalation needed` and strips the present verdict for persistently-cancelled CI", async () => {
    const state = makePrStateVector({ ci: CIState.CancelledRetried });
    const result = await evaluateGatesExecutor(
      makeEvaluateGatesStep({
        state,
        labels: ["approved", "Engine"],
        repo: "owner/repo-a",
        pr: 7,
      }),
      makeNoopRuntime(),
    );
    expect(result.output).toEqual({
      action: Action.Escalate,
      blockingGate: Gate.CiGreen,
      escalationActions: [
        {
          type: GithubActionType.AddLabel,
          params: { repo: "owner/repo-a", pr: 7, label: "escalation needed" },
        },
        {
          type: GithubActionType.RemoveLabel,
          params: { repo: "owner/repo-a", pr: 7, label: "approved" },
        },
      ],
    });
  });

  it("throws on an escalate decision when repo/pr are missing rather than emitting no relabel", () => {
    // A workflow that routes escalate but forgets to supply repo/pr would
    // otherwise silently produce output with no `escalationActions` (#277). The
    // guard throws synchronously, like the schema parse above it.
    const state = makePrStateVector({ ci: CIState.CancelledRetried });
    expect(() =>
      evaluateGatesExecutor(
        makeEvaluateGatesStep({ state, labels: ["approved"] }),
        makeNoopRuntime(),
      ),
    ).toThrow(/missing pr|missing repo/);
  });
});

describe("evaluateGatesExecutor honors decide options", () => {
  it("clears the UAT park via skipUat so a ready-untested PR merges", async () => {
    const state = makePrStateVector({ uat: UATState.ReadyUntested });
    // Without skipUat the UAT gate would park; the option must reach decide().
    expect(decide(state)).toEqual({
      action: Action.Park,
      blockingGate: Gate.UatCleared,
    });
    const result = await evaluateGatesExecutor(
      makeEvaluateGatesStep({ state, options: { skipUat: true } }),
      makeNoopRuntime(),
    );
    expect(result.output).toEqual({
      action: Action.Merge,
      blockingGate: Gate.Merge,
    });
  });
});

describe("evaluateGatesExecutor wiring through the runner", () => {
  it("completes and merges { action, blockingGate } into the run context", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun());
    const state = makePrStateVector({ conflict: MergeConflict.Conflicting });
    await db.create(
      Collections.stepInstances,
      makeEvaluateGatesStep({ state }),
    );
    const runner = createRunner(db, {
      [StepType.Decision]: evaluateGatesExecutor,
    });
    const step = await db.get(Collections.stepInstances, "step-1");
    await runner.dispatch(step!);

    const final = await db.get(Collections.stepInstances, "step-1");
    expect(final?.status).toBe(StepStatus.Completed);
    expect(final?.output).toEqual({
      action: Action.FixReview,
      blockingGate: Gate.NoConflict,
    });
    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.context["action"]).toBe(Action.FixReview);
    expect(run?.context["blockingGate"]).toBe(Gate.NoConflict);
  });
});

describe("evaluateGatesExecutor never consumes a concurrency slot", () => {
  it("admits the decision-type step even when every cap is saturated", () => {
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
    // Pin the rejection enum so a refactor cannot silently drop the
    // zero-cost short-circuit this step relies on.
    expect(AdmissionRejectReason.RepoFull).toBe("repo_full");
  });
});

describe("evaluateGatesExecutor rejects malformed input", () => {
  it("throws when the state vector is missing", () => {
    expect(() =>
      evaluateGatesExecutor(makeEvaluateGatesStep({}), makeNoopRuntime()),
    ).toThrow();
  });
});
