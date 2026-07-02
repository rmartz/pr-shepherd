---
type: Subsystem
title: Execution Tick
description: Drains queued steps through the runner and advances the completed ones — the orchestration half of the execution loop that pairs admission with advance.
resource: src/engine/execution
tags: [engine, execution-loop, scheduler, runner, routing]
---

# Execution Tick

`runExecutionTick(deps)` is the pass that actually _runs_ work. The scheduler's [admission tick](event-driven-scheduler.md) moves steps `pending → queued` under the concurrency caps; this pass picks those `queued` steps up, runs each through the [runner](step-executor-contract.md) (`queued → running → completed|failed`), and — for a step that **completed** — [advances](step-advance.md) the run to its routed next step. Admission fills the queue; execution drains it and produces the next round of `pending` steps. Together with `advanceCompletedStep` this closes the engine's execution loop.

## The unit

- **`dispatchAndAdvance(step, deps)`** — dispatch one queued step through the runner, then (if it completed) advance the run. A **failed** step is not advanced: routing onward is only for success, and whether to retry a failure is a separate decision.
- **`runExecutionTick(deps)`** — list every `queued` step and `dispatchAndAdvance` each. Steps run concurrently and the tick awaits them all, so none is left `queued` when it returns — a later tick cannot re-dispatch a step already run. The admission cap bounds how many steps are `queued` at once, so the fan-out is bounded.

The `Runner` is injected (as everywhere in the engine), so the tick is testable with a scripted executor and production controls the executor registry.

## Boundary: the production wiring is deferred

This is the orchestration _logic_. What is **not** here — and is the remaining slice of [#284](https://github.com/rmartz/pr-shepherd/issues/284):

- **Executor-registry assembly** — constructing `createRunner` with the concrete step executors and their GitHub read/write transports and Claude subprocess. Those production transports do not exist yet (only interfaces + test fakes), so the registry cannot be assembled.
- **Daemon loop wiring** — driving admission + execution ticks from the daemon's scheduler. A daemon that must not block admission while long steps run drives execution on its own cadence.

## Related

- [Step Advance-on-Completion](step-advance.md) — part 1; the routing→next-step half this pass invokes on completion.
- [Event-Driven Scheduler](event-driven-scheduler.md) — the admission tick that fills the queue this pass drains.
- [Step Executor Contract](step-executor-contract.md) — the runner ↔ executor contract each dispatch drives.
