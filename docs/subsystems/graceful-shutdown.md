---
type: Subsystem
title: Graceful Shutdown
description: SIGTERM/SIGINT drain in-flight steps within a bounded grace period, then exit — never hanging.
resource: src/engine/shutdown
tags: [daemon, lifecycle, shutdown, resilience]
---

# Graceful Shutdown

On `SIGTERM`/`SIGINT` the headless daemon stops taking new work, lets in-flight steps settle, and exits — within a bounded time, so a restart or redeploy never tears down a step mid-execution and never hangs.

## Sequence

`gracefulShutdown(handle, options)` runs four steps against the [Engine Bootstrap](engine-bootstrap.md)'s `DaemonHandle`:

1. **Halt admission** — `handle.scheduler.stop()` so the scheduler's next tick admits no further `pending` steps.
2. **Drain** — poll for `running` step instances until none remain, bounded by `drainTimeoutMs` (default 30s, polled every `pollIntervalMs`).
3. **Teardown** — `handle.stop()` (idempotent: detaches every Db subscription, re-stops the scheduler).
4. **Bounded exit** — exit `0` when drained clean; exit non-zero when the grace period elapsed with steps still running (a hard exit, so shutdown is always bounded).

## Cancellation

A running step is cancelled through its executor's own abort seam (e.g. the [`claude_skill`](../steps/claude-skill.md) `SIGTERM → SIGKILL` grace path), not hard-killed. This orchestrator waits for those to settle; the per-step abort wiring is driven by the dispatch/worker loop (Epic 11), and until that lands the bounded drain is the settle-and-exit guarantee.

## Wiring

`installShutdownHandlers(handle, options)` registers the `SIGTERM`/`SIGINT` listeners (running the shutdown once; repeat signals during shutdown are ignored) and returns a cleanup that removes them. The `shepherd start` handler installs it after `bootstrapEngine` returns. The clock, sleep, and exit are injectable so the sequence is unit-tested without real time or terminating the process.

## Related

- [Engine Bootstrap](engine-bootstrap.md) — produces the `DaemonHandle` (with `stop()`) this drives.
- [shepherd CLI](../reference/shepherd-cli.md) — `start` installs the signal handlers.
