---
type: Subsystem
title: Step Executor Contract
description: The runner ↔ executor contract — a terminal ExecutorResult plus a StepExecutorRuntime handle for mid-execution waiting/heartbeat persistence.
resource: src/engine/runner
tags: [runner, executor, lifecycle, heartbeat, waiting]
---

# Step Executor Contract

A step executor is the unit the runner dispatches for one step type. The runner owns the surrounding lifecycle — the `queued → running → completed | failed` status transitions, the start and terminal writes, context propagation, and error capture — so each executor only expresses _what its step does_, not the wrapper boilerplate.

## Signature

```ts
type StepExecutor = (
  step: StepInstance,
  runtime: StepExecutorRuntime,
) => Promise<ExecutorResult>;
```

- **`step`** — the running `StepInstance` snapshot the runner has already transitioned to `running` (with `startedAt` and an initial `heartbeatAt`).
- **`runtime`** — a per-dispatch handle for persisting _intermediate_ lifecycle state (see below). Executors that finish promptly (`decision`, `github_api`, `fork`, `derive_pr_state`, `evaluate_gates`) ignore it.
- **`ExecutorResult`** — `{ output }`, merged shallow into the parent run's `context` on success. Throwing rejects the step to `failed` with the error recorded and `retryCount` bumped.

## Why a runtime handle

The terminal return value cannot express anything that must be durable _while the executor is still running_. Long-running `wait_*` executors need exactly that: they must leave `running`, refresh their heartbeat through a long poll so the heartbeat monitor (#58) does not declare them dead, and account their wait time as it accrues. The runner therefore passes a `StepExecutorRuntime` whose methods write through `Db.update`, scoped to the single step being dispatched.

```ts
interface StepExecutorRuntime {
  enterWaiting: () => Promise<void>;
  heartbeat: (deltaMs?: number) => Promise<void>;
}
```

- **`enterWaiting()`** — persists `running → waiting` and records `waitingAt`. Idempotent: the first call records the transition; repeats are no-ops, so the original `waitingAt` is preserved.
- **`heartbeat(deltaMs?)`** — refreshes `heartbeatAt` to now. With `deltaMs`, the same write also adds it to `metrics.externalWaitMs`, so a poll loop can account its wait incrementally; without it, only the heartbeat is refreshed.

The runner's terminal `completeStep` / `failStep` re-read the step before computing the metrics rollup, so whatever the runtime wrote (`waitingAt`, accumulated `externalWaitMs`) is reflected in the final step and run metrics — the runtime never touches the run-level rollup itself.

## Usage by the wait\_\* executors

- `wait_external` (`src/steps/waitExternal.ts`) calls `enterWaiting()` once, runs its subprocess, then `heartbeat(elapsed)` to record the wall-clock wait.
- `wait_author_push` calls `enterWaiting()` once, then `heartbeat(pollIntervalMs)` after each idle poll so a multi-hour wait stays live.

## Related

- Exported from `src/engine/runner`: `createRunner`, `noopExecutor`, `createStepExecutorRuntime`, and the `StepExecutor` / `StepExecutorRuntime` / `ExecutorResult` / `Runner` types.
- [claude_skill](../steps/claude-skill.md) — the heartbeat-while-running executor pattern.
