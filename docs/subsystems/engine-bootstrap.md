---
type: Subsystem
title: Engine Bootstrap
description: The shepherd start boot sequence that wires the merged building blocks into a running headless daemon.
resource: src/engine/bootstrap
tags: [daemon, bootstrap, lifecycle, scheduler, headless, orchestration]
---

# Engine Bootstrap

The engine bootstrap is the keystone of Epic 6 ([#9](https://github.com/rmartz/pr-shepherd/issues/9), [#207](https://github.com/rmartz/pr-shepherd/issues/207)): it turns the engine's merged building blocks into a single running **headless** daemon. `bootstrapEngine(options)` (in `src/engine/bootstrap`) is what `shepherd start` ([CLI reference](../reference/shepherd-cli.md)) calls to boot the process.

The daemon is headless by design — no HTTP server, no port, no Next.js bootstrap. It runs purely in the background and writes run/step state to Firestore via the admin SDK; the Vercel UI reads that state directly. See [ARCHITECTURE.md](../../ARCHITECTURE.md#deployment-topology) for the split.

## Boot sequence

`bootstrapEngine` runs a fixed sequence, each step a merged building block:

1. **loadConfig** — read and validate `config.yaml` (the [config loader](../../src/config)).
2. **createDb** — construct the admin-SDK Firestore [`Db`](../adapters) keyed on `config.db.adapter`.
3. **recoverFromCrash** — reconcile state a previous crash left behind, **before** the scheduler is allowed to admit work, so recovery never races a tick.
4. **startScheduler** — begin the [event-driven scheduler](event-driven-scheduler.md): it ticks on Firestore-subscribed state changes, with `config.poll.reconcileIntervalSeconds` driving the safety-net reconciliation poll.
5. **startCommandListener** — attach the [commands listener](commands-listener.md) (operator → daemon control plane) on `config.commands.collectionPath`.
6. **runSelfDiscoveryPass** — run an initial [self-discovery](self-discovery.md) pass (`Upfront`) to enroll the configured repos' open PRs.

The pass needs a `WorkflowResolver`. Production wires `createDiskWorkflowResolver`, which reads `workflows/<id>.yaml` through the validated [workflow loader](../../src/config) and caches each id's graph. It needs a `PrReadTransport` too; the live one lands in Epic 12, so `shepherd start` boots with an empty-sweep transport until then.

## Seams for resilience and shutdown

Every collaborator is reached through an injectable `BootstrapDeps`, defaulted to the production implementation. This is what makes the whole sequence unit-testable against an [in-memory `Db`](../adapters) — the smoke test asserts the pieces wire up and the loop starts without throwing, no managed Firestore and no real daemon — and it is the explicit seam Epic 11's orchestration/resilience pieces (drain loop, wait-set, circuit breakers) substitute into.

`bootstrapEngine` returns a `DaemonHandle`: the live `db` / `scheduler` / `commands`, the `crashRecovery` and `initialDiscovery` reports for logging, and `stop()`. `stop()` halts the scheduler, detaches the commands listener, and closes every Db subscription, idempotently. It is the clean seam graceful shutdown ([#208](https://github.com/rmartz/pr-shepherd/issues/208)) drives the in-flight-step drain through — this issue deliberately leaves that drain unimplemented and only guarantees a stoppable handle.
