---
type: Subsystem
title: Event-Driven Scheduler
description: The long-running scheduler daemon — ticks the instant relevant state changes (debounced) via Firestore subscriptions, with a low-frequency reconciliation poll as the safety net.
resource: src/engine/scheduler/eventScheduler.ts
tags: [scheduler, orchestration, subscriptions, reconciliation, debounce]
---

# Event-Driven Scheduler

`runSchedulerTick` (see [the scheduler loop](../../ARCHITECTURE.md)) is the single-pass admission unit: it reads pending step instances, derives concurrency counts fresh, and admits what fits. `startScheduler` is the long-running wrapper that decides _when_ to run that tick.

Rather than a fixed polling interval, it is **event-driven**: a tick fires the instant relevant state changes — a pending `stepInstance` write, and (as those channels land) a UI command or a webhook-derived derivation trigger — via the daemon-side admin-SDK [`Db.subscribe`](../../ARCHITECTURE.md) seam. **Latency comes from push; correctness comes from the poll.**

## Why this is safe

The tick re-derives concurrency counts fresh on every run (it holds no long-lived counter state — the property that makes the scheduler restart-safe). So events are a _trigger_, never a source of truth: an out-of-order, duplicated, or dropped event cannot corrupt admission. The worst a bad event can do is cause a redundant tick, which is a no-op when nothing is admissible.

## The three mechanisms

- **Triggers** — each source is a `TriggerSubscription` thunk that wires one `Db.subscribe` to the scheduler's internal trigger callback. The default watches the pending step-instance set; additional sources plug in via `options.triggers` without erasing their document types. New work and capacity-freeing transitions both surface as changes to that set, so the default alone keeps admission latency low.
- **Debounce / coalescing** — a trigger resets a short debounce timer, so an event storm collapses to a single tick rather than one tick per event. A trigger that arrives while a tick is already in flight is coalesced into exactly one follow-up tick; two ticks never run concurrently, which is what keeps the fresh-count derivation race-free.
- **Reconciliation poll** — a self-re-arming low-frequency timer ticks regardless of whether any event fired. Kept far below the old fixed cadence (push handles latency now), it exists only to cover missed or dropped listener events and crash windows — the "fail open" invariant.

## Dead-step recovery (heartbeat monitor)

Each reconciliation-poll fire also runs [`monitorHeartbeats`](../../src/engine/scheduler/heartbeat.ts): it lists `running` step instances and reaps any whose `heartbeatAt` has gone stale (older than `heartbeat.timeoutSeconds`, defaulting to `heartbeat.intervalSeconds * 4`), marking them `failed` and — when under the retry budget — enqueuing a fresh `pending` retry. This is how a step whose runner crashed without a clean status transition is recovered (vision §4.2, dead-step detection).

Heartbeat detection is **time-based, not admission-triggered**, so it deliberately rides the low-frequency reconciliation poll rather than the debounced admission trigger path — a burst of new pending work must not provoke a heartbeat sweep, and a quiet daemon must still reap dead steps. The sweep runs independently of the admission tick (its own error handler, `onHeartbeatError`), so a Db hiccup in one cannot suppress the other. `heartbeat` config lives on `SchedulerConfig`; the bootstrap maps it from `poll.heartbeatIntervalSeconds`.

## Shutdown

`stop()` flips the running flag, cancels the pending debounce and reconcile timers, detaches every subscription, and awaits the in-flight tick so it drains before resolving. It composes with [graceful shutdown](graceful-shutdown.md), which bounds the overall drain.

Timer primitives are injected (`options.timers`), so tests fire the debounce and poll deterministically instead of waiting on wall-clock time.

## Related

- [Engine Bootstrap](engine-bootstrap.md) — wires `startScheduler` into the `shepherd start` boot sequence.
- [Graceful Shutdown](graceful-shutdown.md) — halts the scheduler and bounds the in-flight drain.
- [Commands Listener](commands-listener.md) — another `Db.subscribe` consumer; a future trigger source for the scheduler.
