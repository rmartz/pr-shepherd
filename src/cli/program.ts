import { Command } from "commander";
import { runForceRetry, runInspect, runStart, runStatus } from "./handlers";

// The four subcommands the `shepherd` binary exposes (Epic #9 scope).
// Values are the literal command names commander registers and matches
// against argv.
export enum ShepherdCommand {
  ForceRetry = "force-retry",
  Inspect = "inspect",
  Start = "start",
  Status = "status",
}

// The set of handlers the program dispatches to, keyed by subcommand.
// Injecting these (rather than importing them inside the action bodies)
// keeps `buildProgram` unit-testable: a test passes spy handlers and
// asserts the right one fires for a given argv, with no real Firestore.
export interface ShepherdHandlers {
  forceRetry: (runId: string) => Promise<void>;
  inspect: (runId: string) => Promise<void>;
  start: () => Promise<void>;
  status: () => Promise<void>;
}

export const defaultHandlers: ShepherdHandlers = {
  forceRetry: runForceRetry,
  inspect: runInspect,
  start: runStart,
  status: runStatus,
};

// Build the commander program for the `shepherd` CLI. The program is
// configured to throw (rather than call `process.exit`) on parse errors
// and on `--help`, so callers — including the entrypoint and tests —
// control process termination themselves.
export function buildProgram(
  handlers: ShepherdHandlers = defaultHandlers,
): Command {
  const program = new Command();

  // `exitOverride()` makes commander throw a `CommanderError` instead of
  // calling `process.exit` for parse errors, `--help`, and `--version`,
  // so the entrypoint owns process termination. Commander still writes
  // help to stdout and errors to stderr through its default output, which
  // is the behavior we want.
  program
    .name("shepherd")
    .description(
      "Headless daemon that drives PRs through review/fix/merge workflows.",
    )
    .exitOverride();

  program
    .command(ShepherdCommand.Start)
    .description("Boot the engine and run the daemon in the foreground.")
    .action(async () => {
      await handlers.start();
    });

  program
    .command(ShepherdCommand.Status)
    .description("Print a summary of active runs and daemon health.")
    .action(async () => {
      await handlers.status();
    });

  program
    .command(`${ShepherdCommand.ForceRetry} <runId>`)
    .description("Reset a run so the scheduler re-dispatches it.")
    .action(async (runId: string) => {
      await handlers.forceRetry(runId);
    });

  program
    .command(`${ShepherdCommand.Inspect} <runId>`)
    .description("Print a run's context, current step, and step history.")
    .action(async (runId: string) => {
      await handlers.inspect(runId);
    });

  return program;
}
