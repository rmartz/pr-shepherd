// Shared types and helpers for the `shepherd` CLI subcommand handlers.
//
// Each subcommand defined in `src/cli/program.ts` dispatches to one
// handler in this directory. Keeping the handlers as standalone modules
// lets later epics fill in a handler's real behavior — e.g. #207 wires
// up `start`'s engine bootstrap — without touching the commander wiring.

// Thrown by a handler whose behavior has not been implemented yet. The
// CLI's top level catches this and prints a clear, actionable message
// rather than letting an unhandled rejection crash the process with a
// raw stack trace.
export class NotImplementedError extends Error {
  constructor(command: string) {
    super(
      `\`shepherd ${command}\` is not yet implemented. ` +
        `This subcommand is scaffolded; its behavior lands in a later Epic 6 issue.`,
    );
    this.name = "NotImplementedError";
  }
}
