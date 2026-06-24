import { Collections } from "@/db/collections";
import {
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import type { Db } from "@/db/types";
import type { PrSnapshot } from "@/engine/derivation/types";
import { WaitKind, isWaitCleared } from "./clearance";

// ---------------------------------------------------------------------------
// Wait-set bulk-poll drain (#110, design §6).
//
// PRs blocked on CI or Copilot do NOT each hold a worker on a sleep. Instead
// their `wait_external` steps sit in `waiting`, and ONE shared bulk poll drains
// the whole set per cycle:
//
//   1. List every `waiting` `wait_external` step.
//   2. Group them by the PR they wait on (one snapshot fetch per distinct PR,
//      never one per step — the whole point of the wait-set).
//   3. Take a single fresh snapshot per PR and apply the clearance predicate
//      for each step's wait kind (`isWaitCleared`).
//   4. Cleared steps transition `waiting → completed` with the verdict in
//      `output`; uncleared steps stay `waiting` for the next cycle.
//
// The drain is a pure single-pass unit driven by the daemon's reconciliation
// cadence (the same shape as `runSchedulerTick`): events/timers are a trigger,
// the bulk poll is the source of truth, and re-deriving the waiting set fresh
// each cycle keeps it restart-safe.
// ---------------------------------------------------------------------------

export interface WaitSetEntry {
  step: StepInstance;
  run: WorkflowRun;
  kind: WaitKind;
}

export interface WaitSetDrainResult {
  // Step ids cleared this cycle (`waiting → completed`).
  cleared: string[];
  // Step ids still waiting after this cycle.
  pending: string[];
  // Distinct PRs polled this cycle (one snapshot each).
  polledPrs: number;
}

export interface WaitSetDrainOptions {
  // Reads one PR snapshot. Production wires the GitHub read transport; tests
  // inject a scripted fake. Mirrors the derivation snapshot seam.
  fetchSnapshot: (run: WorkflowRun) => Promise<PrSnapshot>;
  // Wall-clock now (ms). Injected for deterministic tests.
  now?: () => number;
}

// Map a `wait_external` step's serialized `kind` input to a `WaitKind`. Returns
// undefined for kinds the wait-set does not drain (e.g. `fix_pr`, which waits on
// a spawned child run's CI through its own path), so the caller can skip them.
function waitKindOf(step: StepInstance): WaitKind | undefined {
  const kind = (step.input as { kind?: unknown }).kind;
  if (kind === WaitKind.Ci) return WaitKind.Ci;
  if (kind === WaitKind.CopilotReview) return WaitKind.CopilotReview;
  return undefined;
}

// Build the wait-set: every `waiting` `wait_external` step whose kind the
// wait-set drains, paired with its run. Steps whose run is missing or whose
// kind is undrainable are excluded.
export async function collectWaitSet(db: Db): Promise<WaitSetEntry[]> {
  const waiting = await db.list(Collections.stepInstances, {
    status: StepStatus.Waiting,
    stepType: StepType.WaitExternal,
  });
  const entries: WaitSetEntry[] = [];
  for (const step of waiting) {
    const kind = waitKindOf(step);
    if (kind === undefined) continue;
    const run = await db.get(Collections.workflowRuns, step.runId);
    if (run === undefined) continue;
    entries.push({ step, run, kind });
  }
  return entries;
}

// Drain the wait-set once: one snapshot per distinct PR, clear every entry whose
// predicate is satisfied. A snapshot fetch that throws (a transient GitHub
// failure) leaves every entry for that PR waiting — fail open, never clear on a
// failed read.
export async function drainWaitSet(
  db: Db,
  options: WaitSetDrainOptions,
): Promise<WaitSetDrainResult> {
  const now = options.now ?? Date.now;
  const entries = await collectWaitSet(db);

  // Group by run id so each PR is snapshotted exactly once per cycle. Each
  // group carries its run explicitly so the snapshot fetch never reaches for a
  // possibly-empty list element.
  const byRun = new Map<
    string,
    { run: WorkflowRun; entries: WaitSetEntry[] }
  >();
  for (const entry of entries) {
    const group = byRun.get(entry.run.id);
    if (group === undefined) {
      byRun.set(entry.run.id, { run: entry.run, entries: [entry] });
    } else {
      group.entries.push(entry);
    }
  }

  const cleared: string[] = [];
  const pending: string[] = [];

  await Promise.all(
    [...byRun.values()].map(async ({ run, entries: group }) => {
      let snapshot: PrSnapshot;
      try {
        snapshot = await options.fetchSnapshot(run);
      } catch {
        // Failed read: keep the whole group waiting (fail open).
        for (const entry of group) pending.push(entry.step.id);
        return;
      }
      for (const entry of group) {
        if (isWaitCleared(entry.kind, snapshot)) {
          await db.update(Collections.stepInstances, entry.step.id, {
            status: StepStatus.Completed,
            completedAt: now(),
            output: { passed: true, kind: entry.kind },
          });
          cleared.push(entry.step.id);
        } else {
          pending.push(entry.step.id);
        }
      }
    }),
  );

  return { cleared, pending, polledPrs: byRun.size };
}
