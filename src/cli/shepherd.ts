#!/usr/bin/env -S npx tsx
import { CommanderError } from "commander";
import { buildProgram } from "./program";
import { NotImplementedError } from "./handlers";

// Entrypoint for the `shepherd` binary (Epic 6 / #9). It builds the
// commander program, parses argv, and maps outcomes to process exit
// codes. The program itself is built with `exitOverride()` and silenced
// output (see `buildProgram`) so all termination and printing happens
// here, which also keeps the program unit-testable in isolation.
//
// This is the scaffold: subcommand behavior is dispatched to handler
// modules under `src/cli/handlers/`. Unimplemented handlers throw
// `NotImplementedError`, which is reported as a clear message rather than
// a raw stack trace.
export async function main(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander has already written the help text or error message
      // through its default output. `--help` / `--version` carry an exit
      // code of 0; parse failures carry a nonzero code we surface as-is.
      return error.exitCode;
    }
    if (error instanceof NotImplementedError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

// Run only when invoked as the binary, not when imported (e.g. by tests).
if (process.argv[1]?.endsWith("shepherd.ts")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
