---
type: Reference
title: shepherd CLI
description: The headless daemon's commander-based command-line interface — start, status, force-retry, inspect.
tags: [cli, daemon, commander]
---

# shepherd CLI

`shepherd` is the command-line entrypoint for the headless PR Shepherd daemon. It is a [commander](https://github.com/tj/commander.js) program defined at `src/cli/shepherd.ts`, exposed via the `shepherd` `bin` entry in `package.json`.

The daemon is **headless** — there is no HTTP server, no `server.ts`, and no Next.js bootstrap. The web UI is a separate Vercel deployment that reads daemon state from Firestore directly. See [ARCHITECTURE.md](../../ARCHITECTURE.md#deployment-topology) for the split and Epic [#9](https://github.com/rmartz/pr-shepherd/issues/9) for the runtime goal.

## Subcommands

| Command               | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `start`               | Boot the engine and run the daemon in the foreground.  |
| `status`              | Print a summary of active runs and daemon health.      |
| `force-retry <runId>` | Reset a run so the scheduler re-dispatches it.         |
| `inspect <runId>`     | Print a run's context, current step, and step history. |
| `--help` / `-h`       | Print usage for the program or a subcommand.           |

```bash
shepherd --help
shepherd start
shepherd status
shepherd force-retry <runId>
shepherd inspect <runId>
```

## Structure

The CLI is split for testability:

- **`src/cli/shepherd.ts`** — the entrypoint. Parses argv, then maps outcomes to process exit codes: `0` for success and `--help`, `1` for an unimplemented handler or a parse error. It is the only module that touches `process` so the program itself stays pure.
- **`src/cli/program.ts`** — `buildProgram(handlers)` constructs the commander program and registers each subcommand against an injectable `ShepherdHandlers` map. Injecting handlers keeps dispatch unit-testable with spies and no real Firestore. The `ShepherdCommand` enum holds the literal subcommand names.
- **`src/cli/handlers/`** — one module per subcommand (`start`, `status`, `forceRetry`, `inspect`), barrel-exported from `index.ts`. Separating the handlers lets later issues fill in real behavior without touching the commander wiring.

## Handler status

- **`start`** boots the headless daemon via the [engine bootstrap](../subsystems/engine-bootstrap.md) ([#207](https://github.com/rmartz/pr-shepherd/issues/207)): load config → admin-SDK Firestore `Db` → crash recovery → scheduler + commands listener → initial self-discovery pass. The live PR-read transport that feeds self-discovery lands in Epic 12; until then `start` boots with an empty-sweep transport (enrolling nothing) and warns. Graceful SIGTERM shutdown is the stacked follow-up ([#208](https://github.com/rmartz/pr-shepherd/issues/208)) — `start` leaves a clean seam by holding the daemon handle.
- **`status`**, **`force-retry`**, and **`inspect`** remain scaffolds that throw `NotImplementedError` (reported as a clear "not yet implemented" message rather than a stack trace); they gain thin Firestore-reading/writing implementations in later Epic 6 issues.
