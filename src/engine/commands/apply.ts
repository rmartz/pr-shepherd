import { Collections } from "@/db/collections";
import { CommandType, StepStatus, type Command } from "@/db/schemas";
import type { Db } from "@/db/types";

// ---------------------------------------------------------------------------
// Command application (#121).
//
// `applyCommand` performs the effect of a single decoded command against the
// data store. It is the per-type switch the listener calls once it has decided
// a command is `Pending` and well-formed enough to attempt. Each branch reads
// its target, validates the payload it needs, and mutates exactly the run/step
// the operator addressed.
//
// A malformed or unknown command throws `CommandApplyError`; the listener
// catches it and records the command `Failed` (an acceptance requirement —
// unknown/malformed commands are recorded, never silently dropped). A
// successful apply returns normally and the listener marks it `Handled`.
//
// Idempotency is the listener's job (it only applies `Pending` commands), but
// each effect here is also individually safe to re-apply: pausing an already-
// paused run, resuming an already-running one, or re-enqueuing a step that is
// already `pending` all converge to the same state.
// ---------------------------------------------------------------------------

export class CommandApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandApplyError";
  }
}

// Read a required string field from a command payload, throwing a descriptive
// `CommandApplyError` when it is missing or the wrong type. Keeping payload
// access in one place means every command type fails the same recorded way.
function requireStringField(command: Command, field: string): string {
  const value = command.payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandApplyError(
      `${command.type} command ${command.id} requires a non-empty string "${field}" payload field`,
    );
  }
  return value;
}

async function setRunPaused(
  db: Db,
  command: Command,
  paused: boolean,
): Promise<void> {
  const runId = requireStringField(command, "runId");
  const run = await db.get(Collections.workflowRuns, runId);
  if (run === undefined) {
    throw new CommandApplyError(
      `${command.type} command ${command.id} targets run ${runId}, which does not exist`,
    );
  }
  await db.update(Collections.workflowRuns, runId, {
    paused,
    updatedAt: Date.now(),
  });
}

// Re-enqueue a step as `pending` so the scheduler re-admits it. Clears the
// terminal/failure fields a prior attempt left behind, but preserves
// `retryCount` (the durable attempt history) — a force-retry is an operator
// override, not a reset of the run's accounting.
async function forceRetryStep(db: Db, command: Command): Promise<void> {
  const stepInstanceId = requireStringField(command, "stepInstanceId");
  const step = await db.get(Collections.stepInstances, stepInstanceId);
  if (step === undefined) {
    throw new CommandApplyError(
      `${command.type} command ${command.id} targets step ${stepInstanceId}, which does not exist`,
    );
  }
  await db.update(Collections.stepInstances, stepInstanceId, {
    status: StepStatus.Pending,
    error: undefined,
    queuedAt: undefined,
    startedAt: undefined,
    waitingAt: undefined,
    completedAt: undefined,
    heartbeatAt: undefined,
  });
}

export async function applyCommand(db: Db, command: Command): Promise<void> {
  switch (command.type) {
    case CommandType.ForceRetryStep:
      await forceRetryStep(db, command);
      return;
    case CommandType.PauseRun:
      await setRunPaused(db, command, true);
      return;
    case CommandType.ResumeRun:
      await setRunPaused(db, command, false);
      return;
    default: {
      // Exhaustiveness guard: a new `CommandType` value must add a branch
      // above. A value that arrives via an untyped Firestore read falls here
      // and is recorded `Failed` by the listener rather than silently ignored.
      const exhaustive: never = command.type;
      throw new CommandApplyError(
        `Unknown command type "${String(exhaustive)}" on command ${command.id}`,
      );
    }
  }
}
