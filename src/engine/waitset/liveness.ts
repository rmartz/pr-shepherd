import { Collections } from "@/db/collections";
import { StepStatus, type StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";

// ---------------------------------------------------------------------------
// Stall / liveness defense (#110, design §6–§7).
//
// The coordinator spec's three escalating defenses, mapped onto the daemon
// runtime + the engine's existing heartbeat machinery rather than reimplemented
// as process-group kills:
//
//   1. Per-action HARD TIMEOUT — a `running` step that has exceeded its hard
//      cap (measured from `startedAt`) is force-failed. This is the backstop for
//      a step whose executor is alive enough to heartbeat but is making no
//      progress, which the heartbeat monitor (#58) alone cannot catch.
//   2. Per-wait STALL WARNING — a `waiting` step that has sat past a soft
//      threshold (measured from `waitingAt`) is flagged as stalled. A warning
//      is observational: it surfaces a slow external dependency without failing
//      the step, since a legitimately long CI/Copilot wait must not be killed.
//   3. Liveness WATCHDOG — a last resort. If the daemon as a whole has made no
//      forward progress within a hard cap (no step changed state, the work set
//      is non-empty), it is deadlocked: force-exit so a supervisor restarts it.
//
// All three are pure single-pass checks over the persisted step set (the same
// shape as the heartbeat monitor and scheduler tick), so they are crash-safe
// and unit-testable against an in-memory `Db`.
// ---------------------------------------------------------------------------

const HARD_TIMEOUT_ERROR = "action_hard_timeout";

export interface LivenessConfig {
  // Max wall-clock a `running` step may run before it is force-failed (ms).
  hardTimeoutMs: number;
  // How long a `waiting` step may sit before it is flagged stalled (ms).
  stallWarningMs: number;
  nowMs?: () => number;
}

export interface LivenessReport {
  // Step ids force-failed for exceeding the per-action hard timeout.
  timedOut: string[];
  // Step ids flagged as stalled (still waiting; not failed).
  stalled: string[];
}

// One pass: force-fail steps over the hard timeout, flag waits over the stall
// threshold. A re-read guards the fail against a TOCTOU race (the runner may
// have settled the step between the list and the write).
export async function checkLiveness(
  db: Db,
  config: LivenessConfig,
): Promise<LivenessReport> {
  const now = (config.nowMs ?? Date.now)();
  const running = await db.list(Collections.stepInstances, {
    status: StepStatus.Running,
  });
  const waiting = await db.list(Collections.stepInstances, {
    status: StepStatus.Waiting,
  });

  const timedOut: string[] = [];
  for (const step of running) {
    if (step.startedAt === undefined) continue;
    if (now - step.startedAt < config.hardTimeoutMs) continue;
    const current = await db.get(Collections.stepInstances, step.id);
    if (current?.status !== StepStatus.Running) continue;
    await db.update(Collections.stepInstances, step.id, {
      status: StepStatus.Failed,
      error: HARD_TIMEOUT_ERROR,
      completedAt: now,
    });
    timedOut.push(step.id);
  }

  const stalled: string[] = [];
  for (const step of waiting) {
    if (step.waitingAt === undefined) continue;
    if (now - step.waitingAt >= config.stallWarningMs) stalled.push(step.id);
  }

  return { timedOut, stalled };
}

export interface LivenessWatchdogConfig {
  // Max wall-clock with no forward progress before the daemon is declared
  // deadlocked and force-exited (ms).
  deadlockTimeoutMs: number;
  nowMs?: () => number;
  // Called with a non-zero exit code when a deadlock is detected. Injected so
  // tests don't terminate the process; defaults to `process.exit`.
  onExit?: (code: number) => void;
}

export interface WatchdogState {
  // The progress fingerprint observed at the previous check.
  lastFingerprint: string;
  // When `lastFingerprint` was first observed (ms).
  lastProgressAt: number;
}

// A fingerprint of the active work set's forward progress: the multiset of
// (step id, status) over running + waiting steps. Any admission, completion, or
// status transition changes it; a stable fingerprint over the deadlock window
// with work still present means nothing is moving.
function progressFingerprint(active: StepInstance[]): string {
  return active
    .map((s) => `${s.id}:${s.status}`)
    .sort()
    .join("|");
}

// One watchdog tick. Compares the current progress fingerprint against the
// prior one in `state`. If it has changed (or the work set is empty), progress
// is being made — refresh the state and continue. If it is unchanged and the
// deadlock window has elapsed with work still in flight, force-exit. Returns the
// next `WatchdogState` to thread into the following tick.
export async function watchdogTick(
  db: Db,
  config: LivenessWatchdogConfig,
  state: WatchdogState,
): Promise<WatchdogState> {
  const now = (config.nowMs ?? Date.now)();
  const running = await db.list(Collections.stepInstances, {
    status: StepStatus.Running,
  });
  const waiting = await db.list(Collections.stepInstances, {
    status: StepStatus.Waiting,
  });
  const active = [...running, ...waiting];
  const fingerprint = progressFingerprint(active);

  // Empty work set or changed fingerprint = forward progress.
  if (active.length === 0 || fingerprint !== state.lastFingerprint) {
    return { lastFingerprint: fingerprint, lastProgressAt: now };
  }

  // Unchanged with work present: deadlocked if the window has elapsed.
  if (now - state.lastProgressAt >= config.deadlockTimeoutMs) {
    const onExit = config.onExit ?? ((code: number) => process.exit(code));
    onExit(1);
  }
  return state;
}
