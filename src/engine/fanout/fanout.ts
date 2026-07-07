import { randomUUID } from "node:crypto";
import { Collections } from "@/db/collections";
import {
  DEFAULT_STEP_MAX_RETRIES,
  StepStatus,
  type StepInstance,
  type StepType,
} from "@/db/schemas";
import type { Db } from "@/db/types";

// ---------------------------------------------------------------------------
// Fan-out: spawn child steps under a parent (#280).
//
// `spawnChildSteps` is the scatter half of the step-level fan-out/fan-in
// primitive. An executor that needs to run N sub-actions in parallel (e.g. the
// `github_api` batch split, #281) calls this to persist N `pending` child
// `stepInstances`, each linked to the spawning step via `parentStepId`, then
// returns `{ output: {}, suspended: true }` so the runner parks it in `waiting`
// rather than completing it. The scheduler admits and runs the children like
// any other step; the fan-in join (`runJoinTick`) resumes the parent once they
// are all terminal. See `join.ts` for the gather half.
//
// Ordering: children are stamped with strictly increasing `createdAt`
// (`base + index`) so their spawn order is recoverable from persisted state
// alone — the join sorts by `createdAt` to assign each child a stable `index`
// in the aggregated output, and that ordering survives a daemon restart.
// ---------------------------------------------------------------------------

// One child step to spawn. `stepType` / `stepDefinitionId` / `input` mirror the
// fields the runner and routing need; `maxRetries` defaults to the shared
// per-step budget when omitted.
export interface FanOutChildSpec {
  stepType: StepType;
  stepDefinitionId: string;
  input: Record<string, unknown>;
  maxRetries?: number;
  // Fan-out child policy (#313). `optional` children never gate the join and
  // their failure is ignored. `deadlineMs` is a wait bound *relative to spawn*:
  // if the child is still non-terminal that many ms after being spawned, the
  // join force-terminates it as `skipped`. Both default to unset (required, no
  // deadline).
  optional?: boolean;
  deadlineMs?: number;
}

export interface SpawnChildStepsOptions {
  // Test-injectable id factory + clock. Default to crypto.randomUUID / Date.now,
  // matching `advanceCompletedStep`.
  newId?: () => string;
  now?: () => number;
}

// Persist one `pending` child step per spec, linked to `parent` via
// `parentStepId`, and return their ids in spec order. The caller is responsible
// for returning `{ suspended: true }` so the parent is parked; spawning at
// least one child is required, because a `waiting` step with no children is
// indistinguishable from an external `wait_*` step and the join would never
// resume it.
export async function spawnChildSteps(
  db: Db,
  parent: StepInstance,
  children: FanOutChildSpec[],
  options: SpawnChildStepsOptions = {},
): Promise<string[]> {
  if (children.length === 0) {
    throw new Error(
      `spawnChildSteps: cannot fan out step ${parent.id} with zero children`,
    );
  }
  const newId = options.newId ?? ((): string => randomUUID());
  const now = options.now ?? Date.now;
  const base = now();

  const ids: string[] = [];
  for (const [index, spec] of children.entries()) {
    const child: StepInstance = {
      id: newId(),
      runId: parent.runId,
      parentStepId: parent.id,
      // Only persist policy fields when set, so ordinary and required children
      // carry neither.
      ...(spec.optional === true ? { optional: true } : {}),
      ...(spec.deadlineMs !== undefined
        ? { deadlineAt: base + spec.deadlineMs }
        : {}),
      stepDefinitionId: spec.stepDefinitionId,
      stepType: spec.stepType,
      status: StepStatus.Pending,
      input: spec.input,
      output: {},
      logs: [],
      retryCount: 0,
      maxRetries: spec.maxRetries ?? DEFAULT_STEP_MAX_RETRIES,
      // Strictly increasing so spawn order is recoverable from persisted state.
      createdAt: base + index,
      metrics: {
        claudeMs: 0,
        activeMs: 0,
        scheduleWaitMs: 0,
        externalWaitMs: 0,
      },
    };
    await db.create(Collections.stepInstances, child);
    ids.push(child.id);
  }
  return ids;
}
