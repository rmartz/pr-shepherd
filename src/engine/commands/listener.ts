import { Collections } from "@/db/collections";
import { CommandStatus, type Command } from "@/db/schemas";
import type { Db, Unsubscribe } from "@/db/types";
import { applyCommand, CommandApplyError } from "./apply";

// ---------------------------------------------------------------------------
// Commands listener (#121).
//
// `startCommandListener` is the daemon-side consumer of the operator → daemon
// control plane (ARCHITECTURE.md). It subscribes — via the #119 admin-SDK
// `Db.subscribe` seam — to the `commands` collection, filtered to `Pending`
// documents, and on every snapshot applies each pending command to its target
// run/step, then marks the document terminal (`Handled` / `Failed`).
//
// Idempotency (an acceptance requirement) has two layers:
//   1. The subscription filter + the terminal write mean a command is only
//      ever in a processable state once: applying it flips it out of
//      `Pending`, so a re-delivered snapshot no longer contains it.
//   2. A re-delivery that races ahead of the terminal write (the same
//      `Pending` doc appears in two back-to-back snapshots) is caught by the
//      in-flight/seen `Set`, so the effect runs at most once per command id.
//
// Snapshots are processed through a single serial queue so two overlapping
// snapshots can't interleave their reads and writes.
// ---------------------------------------------------------------------------

export interface CommandListenerHandle {
  // Detach the subscription. Idempotent.
  stop: Unsubscribe;
  // Resolves once the in-flight snapshot (if any) has finished processing.
  // Tests await this to observe effects deterministically without timers.
  drain: () => Promise<void>;
}

export interface StartCommandListenerOptions {
  // Firestore collection path the daemon watches. Defaults to the canonical
  // `commands` collection; the daemon passes `config.commands.collectionPath`.
  collectionPath?: string;
  // Invoked after a command reaches a terminal state. Lets the daemon log /
  // surface command outcomes without the listener taking a logging dependency.
  onProcessed?: (command: Command, status: CommandStatus) => void;
  // Invoked when marking a command terminal itself fails (a Db write error).
  // Separate from `onProcessed` because the command's outcome is unrecorded.
  onError?: (command: Command, err: unknown) => void;
}

// Outcome of attempting one command: a terminal status plus, on failure, the
// message to persist on the document so the failure is auditable.
interface ApplyResult {
  status: CommandStatus;
  error: string | undefined;
}

// Run a command's effect and classify the outcome. A `CommandApplyError`
// (unknown type / malformed payload / missing target) and any other thrown
// error both record `Failed` with the message — unknown/malformed commands are
// recorded, never silently dropped (an acceptance requirement).
async function applyAndClassify(
  db: Db,
  command: Command,
): Promise<ApplyResult> {
  try {
    await applyCommand(db, command);
    return { status: CommandStatus.Handled, error: undefined };
  } catch (err) {
    const message =
      err instanceof CommandApplyError || err instanceof Error
        ? err.message
        : String(err);
    return { status: CommandStatus.Failed, error: message };
  }
}

export function startCommandListener(
  db: Db,
  options: StartCommandListenerOptions = {},
): CommandListenerHandle {
  const collection =
    options.collectionPath === undefined
      ? Collections.commands
      : { ...Collections.commands, name: options.collectionPath };

  // Command ids whose effect has been started (and is in-flight or done) this
  // process. Guards against a re-delivered snapshot re-applying a command
  // before its terminal write has landed.
  const handled = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  const processCommand = async (command: Command): Promise<void> => {
    if (command.status !== CommandStatus.Pending) return;
    if (handled.has(command.id)) return;
    handled.add(command.id);

    const result = await applyAndClassify(db, command);
    try {
      await db.update(collection, command.id, {
        status: result.status,
        handledAt: Date.now(),
        error: result.error,
      });
      options.onProcessed?.(command, result.status);
    } catch (err) {
      // The effect ran but recording it failed. Drop the id from `handled` so
      // a later snapshot can retry the terminal write; the effect itself is
      // idempotent, so re-running it is safe.
      handled.delete(command.id);
      options.onError?.(command, err);
    }
  };

  const onChange = (commands: Command[]): void => {
    queue = queue.then(async () => {
      for (const command of commands) {
        await processCommand(command);
      }
    });
  };

  const unsubscribe = db.subscribe(
    collection,
    { status: CommandStatus.Pending },
    onChange,
  );

  return {
    stop: unsubscribe,
    drain: () => queue,
  };
}
