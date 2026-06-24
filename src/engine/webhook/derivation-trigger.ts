import { randomUUID } from "node:crypto";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
  type WebhookEvent,
  type WorkflowRun,
} from "@/db/schemas";
import type { Db } from "@/db/types";
import {
  eventToTargets,
  isBranchTarget,
  type EventTarget,
} from "./event-target";

// ---------------------------------------------------------------------------
// Event → derivation trigger (Epic 12, #112).
//
// `triggerDerivations` is the event-sourced replacement for the polling
// trigger: given one persisted webhook delivery (#111), it maps the event to
// the PR(s) it affects (event-target.ts), finds the tracked run for each, and
// enqueues a fresh `derive_pr_state` step against that run. That re-seeds the
// run at the head of Epic 10's lifecycle loop —
// `derive_pr_state → evaluate_gates → …` (workflows/base-pr.yaml) — so the
// next scheduler tick re-derives state and the gate model picks the next
// action. **No lifecycle change**: only the *source* of the trigger swaps
// from poll to event (vision §4.1, §13.1; self-discovery design §6).
//
// Safety mirrors the scheduler's "events are a trigger, never a source of
// truth": re-deriving is idempotent because state is derived, not stored, so a
// duplicated or out-of-order event at worst causes a redundant derivation. An
// event that names no tracked PR is **dropped cleanly** — logged and a no-op —
// rather than enrolling new work (enrolment stays the discovery loop's job).
// ---------------------------------------------------------------------------

// Run statuses still eligible to receive an event-driven re-derivation. A
// terminal run (cancelled / completed / failed) is not re-triggered — the
// event arrives for a PR whose workflow has already concluded.
const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  RunStatus.Pending,
  RunStatus.Running,
]);

// Why an event produced no derivation trigger — surfaced per dropped event so
// a caller (or log) can distinguish "touched no PR" from "PR not tracked".
export enum DropReason {
  // The payload named no PR (plain-issue comment, tag push, malformed body).
  NoTarget = "no_target",
  // The named PR(s) have no active tracked run — nothing to re-derive.
  Untracked = "untracked",
}

// One enqueued derivation cycle: the run re-seeded and the step instance
// created to drive it.
export interface DerivationTrigger {
  runId: string;
  stepInstanceId: string;
  repo: string;
  prNumber: number;
}

export interface TriggerDerivationsResult {
  // The derivation cycles enqueued, one per matched active run.
  triggered: DerivationTrigger[];
  // Set when the event produced no trigger at all, explaining why it was
  // dropped. Absent when at least one derivation was enqueued.
  dropped?: DropReason;
}

export interface TriggerDerivationsDependencies {
  db: Db;
  // Resolve a `push` event's branch to the PR number(s) whose head is that
  // branch. Injected because runs key on `repo + prNumber`, not branch — the
  // production wiring reads open PRs via the discovery transport; tests inject
  // a scripted resolver. Omitted ⇒ push branch targets resolve to nothing.
  resolveBranch?: (repo: string, branch: string) => Promise<number[]>;
  // Test-injectable id factory + clock, mirroring `enrollPr`'s seams.
  newId?: () => string;
  now?: () => number;
  // Per-step retry budget for the seeded derivation step. Defaults to 3,
  // matching enrolment and the other run-creation paths.
  maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 3;
// The step id of the lifecycle's head derivation step (workflows/base-pr.yaml).
// Re-seeding a run here restarts the derive → evaluate_gates loop.
const DERIVE_STEP_ID = "derive_pr_state";

// Resolve every target the event implicates to concrete `{ repo, prNumber }`
// pairs, expanding branch targets via the injected resolver. PR-number targets
// pass through unchanged.
interface PrRef {
  repo: string;
  prNumber: number;
}

async function resolvePrNumbers(
  targets: EventTarget[],
  deps: TriggerDerivationsDependencies,
): Promise<PrRef[]> {
  const resolved: PrRef[] = [];
  for (const target of targets) {
    if (!isBranchTarget(target)) {
      resolved.push(target);
      continue;
    }
    const prNumbers =
      (await deps.resolveBranch?.(target.repo, target.branch)) ?? [];
    for (const prNumber of prNumbers) {
      resolved.push({ repo: target.repo, prNumber });
    }
  }
  return resolved;
}

async function findActiveRun(
  db: Db,
  repo: string,
  prNumber: number,
): Promise<WorkflowRun | undefined> {
  const candidates = await db.list(Collections.workflowRuns, {
    repo,
    prNumber,
  });
  return candidates.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
}

function seedDeriveStep(
  runId: string,
  stepInstanceId: string,
  createdAt: number,
  maxRetries: number,
): StepInstance {
  return {
    id: stepInstanceId,
    runId,
    stepDefinitionId: DERIVE_STEP_ID,
    stepType: StepType.DerivePrState,
    status: StepStatus.Pending,
    input: {},
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
}

// Map one persisted webhook delivery to derivation triggers and enqueue them.
// Returns the enqueued cycles, or a `dropped` reason when the event touched no
// tracked PR. Idempotent at the lifecycle level: re-deriving is always safe.
export async function triggerDerivations(
  event: WebhookEvent,
  deps: TriggerDerivationsDependencies,
): Promise<TriggerDerivationsResult> {
  const targets = eventToTargets(event);
  if (targets.length === 0) {
    return { triggered: [], dropped: DropReason.NoTarget };
  }

  const prRefs = await resolvePrNumbers(targets, deps);
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? Date.now;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;

  const triggered: DerivationTrigger[] = [];
  const seen = new Set<string>();
  for (const { repo, prNumber } of prRefs) {
    const run = await findActiveRun(deps.db, repo, prNumber);
    // A PR with no active run is untracked — nothing to re-derive. Dedupe on
    // run id so multiple targets resolving to the same run enqueue one cycle.
    if (run === undefined || seen.has(run.id)) continue;
    seen.add(run.id);

    const stepInstanceId = newId();
    await deps.db.create(
      Collections.stepInstances,
      seedDeriveStep(run.id, stepInstanceId, now(), maxRetries),
    );
    triggered.push({ runId: run.id, stepInstanceId, repo, prNumber });
  }

  return triggered.length === 0
    ? { triggered, dropped: DropReason.Untracked }
    : { triggered };
}
