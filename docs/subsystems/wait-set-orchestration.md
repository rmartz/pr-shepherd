---
type: Subsystem
title: Wait-Set Orchestration & Stall/Liveness Defense
description: PRs blocked on CI/Copilot drain through one shared bulk poll instead of holding a worker on a sleep; per-action hard timeouts, per-wait stall warnings, and a liveness watchdog defend against stalls and deadlock; graceful shutdown aggregates per-PR results on interrupt.
resource: src/engine/waitset
tags: [orchestration, wait-set, ci, copilot, liveness, watchdog, shutdown]
---

# Wait-Set Orchestration & Stall/Liveness Defense

The per-PR lifecycle runs for many PRs at once. This subsystem (#110) is the cross-PR layer that keeps that fleet from wasting workers on sleeps and from stalling invisibly. It has three concerns.

## 1. Wait-sets, not held workers

A PR blocked on CI or Copilot does **not** hold a worker on a `sleep`. Its `wait_external` step sits in `waiting`, and one shared **bulk poll** drains the whole set per cycle (`drainWaitSet`):

1. List every `waiting` `wait_external` step.
2. Group by the PR each waits on — one snapshot fetch per **distinct PR**, never one per step.
3. Take a single fresh snapshot per PR and apply the **clearance predicate** for each step's wait kind.
4. Cleared steps transition `waiting → completed`; uncleared steps stay `waiting` for the next cycle.

A snapshot read that throws leaves every entry for that PR waiting (**fail open** — never clear on a failed read). Re-deriving the waiting set fresh each cycle keeps the drain restart-safe, the same property `runSchedulerTick` relies on.

### CI clearance: both conditions

The CI predicate (`isCiCleared`) is stricter than "CI is not running". It requires **both**:

- **no GitHub-Actions suite is still running**, AND
- **a landed verdict** — a terminal CI conclusion (`passed` / `failing` / `cancelled` / `cancelled_retried`), not a transient `running` or `needs_auth`.

A lone pending non-Actions status (e.g. Vercel) never clears the wait, and an Actions suite mid-run is never mistaken for a verdict. The [CI axis](pr-state-derivation.md) (`deriveCi`) supplies the Actions-only rule; the predicate layers the "landed verdict" gate on top. `isCopilotCleared` clears once Copilot has produced an actual review (resolved or open threads), not a mere request or a refusal.

## 2. Stall / liveness defense

Three escalating defenses, mapped onto the daemon runtime and the engine's existing heartbeat machinery (#58) rather than reimplemented as process-group kills:

- **Per-action hard timeout** (`checkLiveness`) — a `running` step past its hard cap (from `startedAt`) is force-failed. This catches a step that heartbeats but makes no progress, which the heartbeat monitor alone cannot.
- **Per-wait stall warning** — a `waiting` step past a soft threshold (from `waitingAt`) is flagged stalled. Observational only: a legitimately long CI/Copilot wait is surfaced, never killed.
- **Liveness watchdog** (`watchdogTick`) — the last resort. A progress fingerprint over the active step set is compared across ticks; if it is unchanged for the whole deadlock window with work still in flight, the daemon is deadlocked and force-exits so a supervisor restarts it.

## 3. Graceful-drain aggregation

On interrupt the daemon drains in-flight work ([Graceful Shutdown](graceful-shutdown.md), #208) and reports **where each PR landed**, not just a global count. `aggregateDrainResults` rolls the step set up — joined to its `workflowRuns` for `repo` + `prNumber` — into one `PrDrainSummary` per PR (completed / failed / still in flight). `gracefulShutdown` computes it once after the drain settles and returns it on `GracefulShutdownResult.aggregate`.

## Related

- [Step Executor Contract](step-executor-contract.md) — the `enterWaiting()` / `heartbeat()` runtime handle (#78) the `wait_*` executors persist `waiting` state through; the wait-set drains those steps.
- [Graceful Shutdown](graceful-shutdown.md) — the bounded SIGTERM/SIGINT drain this subsystem's per-PR aggregation feeds.
- [Event-Driven Scheduler](event-driven-scheduler.md) — the reconciliation cadence that drives the bulk poll; events trigger, the poll is the source of truth.
- [PR State Derivation](pr-state-derivation.md) — the CI / Copilot axes the clearance predicates read.
