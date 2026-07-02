import { randomUUID } from "node:crypto";
import type { WorkflowGraph } from "@/config";
import { Collections } from "@/db/collections";
import { RunStatus, StepStatus, type StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";
import { evaluateRouting, type RoutingRule } from "@/engine/routing";

// ---------------------------------------------------------------------------
// Step advance-on-completion (issue #284, part 1 of the execution loop).
//
// When a step reaches `completed`, its workflow definition's routing rules
// decide what runs next. `advanceCompletedStep` loads the run's workflow graph,
// finds the completed step's definition, evaluates its routing against
// `{ output: step.output, context: run.context }`, and either:
//   - creates the next `pending` `stepInstance` (mirroring how enrollment seeds
//     the first step), or
//   - on a terminal (`next: null`) route, marks the run `completed`.
//
// This is the piece that was missing from the engine entirely: `evaluateRouting`
// had no caller, so a completed step never produced a successor. The companion
// half — dispatching `queued` steps through the runner and invoking this on
// completion — is tracked separately (#284, part 2), because it entangles with
// the production executor registry.
//
// Contract: the caller invokes this exactly once per step completion (the
// dispatch loop calls it in the runner-completion continuation). It is not a
// self-guarding idempotent primitive — crash-replay reconciliation (re-advancing
// a completed step whose successor was never created) belongs to the dispatch
// half. A defensive status check still skips a non-completed step so a
// misinvocation cannot fabricate a successor from an in-flight step.
//
// The run's `context` is read fresh here: the runner merges a step's output into
// the run context before this runs, so `run.context` already reflects the
// just-completed step (routing conditions may read either `output.*` or the
// accumulated `context.*`).
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;

export type AdvanceResult =
  | {
      kind: "advanced";
      nextStepInstanceId: string;
      nextStepDefinitionId: string;
    }
  | { kind: "completed" }
  | { kind: "skipped"; reason: string };

export interface AdvanceDeps {
  db: Db;
  // Resolve a run's workflow graph by its workflow id. Injected rather than
  // reading files here so the advance stays unit-testable; production wires the
  // `WorkflowRegistry` lookup.
  getGraph: (workflowId: string) => WorkflowGraph | undefined;
  // Retry budget seeded on the created successor step. Defaults to 3, matching
  // enrollment's default.
  maxRetries?: number;
  // Test-injectable id factory + clock. Default to crypto.randomUUID / Date.now.
  newId?: () => string;
  now?: () => number;
}

export async function advanceCompletedStep(
  step: StepInstance,
  deps: AdvanceDeps,
): Promise<AdvanceResult> {
  if (step.status !== StepStatus.Completed) {
    return {
      kind: "skipped",
      reason: `step ${step.id} is ${step.status}, not completed`,
    };
  }

  const newId = deps.newId ?? ((): string => randomUUID());
  const now = deps.now ?? Date.now;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;

  const run = await deps.db.get(Collections.workflowRuns, step.runId);
  if (run === undefined) {
    return { kind: "skipped", reason: `run ${step.runId} does not exist` };
  }

  const graph = deps.getGraph(run.workflowId);
  if (graph === undefined) {
    throw new Error(
      `advance: no workflow graph registered for "${run.workflowId}" (run ${run.id})`,
    );
  }

  const stepDef = graph.steps.find((s) => s.id === step.stepDefinitionId);
  if (stepDef === undefined) {
    throw new Error(
      `advance: step definition "${step.stepDefinitionId}" not found in workflow "${graph.id}"`,
    );
  }

  // The loader models a terminal route as `next: undefined`; the evaluator's
  // `RoutingRule` models it as `next: null`. Normalize to the evaluator's shape.
  const rules: RoutingRule[] = stepDef.routing.map((rule) => ({
    condition: rule.condition,
    next: rule.next ?? null,
  }));
  const nextDefinitionId = evaluateRouting(rules, {
    output: step.output,
    context: run.context,
  });

  if (nextDefinitionId === null) {
    // Terminal route — the run has reached the end of its workflow. Clear the
    // active-step pointer so crash recovery does not treat the finished run as
    // an orphan (it looks `currentStepId` up as a step instance).
    await deps.db.update(Collections.workflowRuns, run.id, {
      status: RunStatus.Completed,
      currentStepId: undefined,
      updatedAt: now(),
      completedAt: run.completedAt ?? now(),
    });
    return { kind: "completed" };
  }

  const nextDef = graph.steps.find((s) => s.id === nextDefinitionId);
  if (nextDef === undefined) {
    throw new Error(
      `advance: routing target "${nextDefinitionId}" not found in workflow "${graph.id}"`,
    );
  }

  const createdAt = now();
  const nextStepInstanceId = newId();
  const nextStep: StepInstance = {
    id: nextStepInstanceId,
    runId: run.id,
    stepDefinitionId: nextDef.id,
    stepType: nextDef.stepType,
    status: StepStatus.Pending,
    // Stored verbatim, exactly as enrollment seeds the first step's input —
    // `{{ context.* }}` interpolation is a dispatch-time concern (#284, part 2).
    input: nextDef.input,
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries,
    createdAt,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
  };
  await deps.db.create(Collections.stepInstances, nextStep);
  // Point the run at the new active step by its *instance* id — the identifier
  // crash recovery resolves against the step-instance collection.
  await deps.db.update(Collections.workflowRuns, run.id, {
    status: RunStatus.Running,
    currentStepId: nextStepInstanceId,
    updatedAt: createdAt,
  });

  return {
    kind: "advanced",
    nextStepInstanceId,
    nextStepDefinitionId: nextDef.id,
  };
}
