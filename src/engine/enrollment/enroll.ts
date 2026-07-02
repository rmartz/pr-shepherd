import { randomUUID } from "node:crypto";
import type { WorkflowGraph } from "@/config";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  type StepInstance,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@/db/schemas";
import type { Db } from "@/db/types";
import type { DiscoveredPr } from "@/engine/discovery";

// ---------------------------------------------------------------------------
// Run enrollment (vision §4.1 lifecycle, §5, §8.3 idempotency; issue #126).
//
// `enrollPr` is the second half of triage: given a discovered PR and the
// already-matched workflow's loaded definition, it creates a `pending`
// `workflowRun` (with the definition's version pinned), seeds the first
// `stepInstance` (the first step in the loaded graph), and writes a reference
// copy of the definition to `workflowDefinitions` so the exact version is
// auditable after the YAML evolves.
//
// **Idempotency (§8.3)**: enrollment is keyed on `repo + prNumber +
// workflowId`. If a non-terminal run already exists for that key the PR is not
// re-enrolled — `enrollPr` returns the existing run's id with `created:
// false`, leaving the prior run and its steps untouched. Terminal runs
// (cancelled / completed / failed) do not block re-enrollment, so a PR that
// finished a workflow and is later re-discovered can start a fresh run.
// ---------------------------------------------------------------------------

// Run statuses that still count as "active" for the dedupe guard. A run in any
// other status is terminal and does not block re-enrollment.
const NON_TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  RunStatus.Pending,
  RunStatus.Running,
]);

export interface EnrollOptions {
  // Test-injectable id factory + clock; default to crypto.randomUUID and
  // Date.now in production (mirrors the fork executor's seams).
  newId?: () => string;
  now?: () => number;
  // Per-step retry budget for the seeded first step. Defaults to 3, matching
  // the engine's other run-creation paths.
  maxRetries?: number;
}

export interface EnrollResult {
  runId: string;
  // `false` when an existing non-terminal run satisfied the idempotency guard
  // and no new run was created.
  created: boolean;
}

const DEFAULT_MAX_RETRIES = 3;

export async function enrollPr(
  db: Db,
  pr: DiscoveredPr,
  graph: WorkflowGraph,
  options: EnrollOptions = {},
): Promise<EnrollResult> {
  const existing = await findActiveRun(db, pr, graph.id);
  if (existing !== undefined) {
    return { runId: existing.id, created: false };
  }

  const newId = options.newId ?? (() => randomUUID());
  const now = options.now ?? Date.now;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  const firstStep = graph.steps[0];
  if (firstStep === undefined) {
    // The workflow loader guarantees `steps.min(1)`, so an empty graph cannot
    // reach here through normal loading. Guard anyway rather than indexing a
    // possibly-undefined element under `noUncheckedIndexedAccess`.
    throw new Error(
      `Cannot enroll PR ${pr.repo}#${String(pr.number)}: workflow "${graph.id}" has no steps.`,
    );
  }

  const runId = newId();
  // Pre-generate the first step's *instance* id so the run can point at it.
  // `currentStepId` must be the step-instance id, not the definition id
  // (`firstStep.id`): crash recovery resolves `currentStepId` against the
  // step-instance collection, so a definition id there makes recovery treat a
  // healthy run as an orphan (#285).
  const stepInstanceId = newId();
  const createdAt = now();

  const run: WorkflowRun = {
    id: runId,
    workflowId: graph.id,
    workflowVersion: graph.version,
    repo: pr.repo,
    prNumber: pr.number,
    prTitle: pr.title,
    status: RunStatus.Pending,
    childRunIds: [],
    context: {},
    currentStepId: stepInstanceId,
    createdAt,
    updatedAt: createdAt,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
  };
  await db.create(Collections.workflowRuns, run);

  const stepInstance: StepInstance = {
    id: stepInstanceId,
    runId,
    stepDefinitionId: firstStep.id,
    stepType: firstStep.stepType,
    status: StepStatus.Pending,
    input: firstStep.input,
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
  await db.create(Collections.stepInstances, stepInstance);

  const definition: WorkflowDefinition = {
    id: newId(),
    workflowId: graph.id,
    version: graph.version,
    source: graph.source,
    createdAt,
  };
  await db.create(Collections.workflowDefinitions, definition);

  return { runId, created: true };
}

// Look up a non-terminal run for the dedupe key (repo + prNumber +
// workflowId). The adapter's partial-match filter narrows on the three exact
// fields; the status filter is applied in memory since "non-terminal" is a set
// rather than a single value.
async function findActiveRun(
  db: Db,
  pr: DiscoveredPr,
  workflowId: string,
): Promise<WorkflowRun | undefined> {
  const candidates = await db.list(Collections.workflowRuns, {
    repo: pr.repo,
    prNumber: pr.number,
    workflowId,
  });
  return candidates.find((run) => NON_TERMINAL_RUN_STATUSES.has(run.status));
}
