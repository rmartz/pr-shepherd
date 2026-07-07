---
type: Subsystem
title: Step Fan-Out / Fan-In
description: A step spawns N child steps and parks in `waiting`; the scheduler joins it once every required child is terminal, aggregating their outputs — the scatter/gather primitive under the github_api batch split, with optional/deadline-bounded children.
resource: src/engine/fanout
tags: [engine, execution-loop, step-orchestration, fan-out]
---

# Step Fan-Out / Fan-In

The engine can run a **step** that scatters into N child **steps** and gathers their results — the primitive missing before #280. `fork` (#65) spawns child _runs_ fire-and-forget and nothing waits on them; the `wait_*` machinery blocks a single step on an _external_ condition (CI, a push). Neither lets one step spawn sibling steps and block until they all finish. This is that: **step-level fan-out/fan-in (scatter/gather)**, and the foundation for splitting a `github_api` batch into per-action steps with independent retry (#281).

## The two halves

**Scatter — `spawnChildSteps(db, parent, specs, opts?)`.** An executor that needs to run N sub-actions in parallel calls this to persist one `pending` child `stepInstance` per spec, each linked to the spawning step through the new `parentStepId` field. It then returns `{ output: {}, suspended: true }`. The runner reads `suspended` and parks the parent in **`waiting`** — not `completed` — writing no output and rolling up no metrics yet. The children are ordinary steps: the scheduler admits and dispatches them under the normal concurrency caps.

**Gather — `runJoinTick(deps)`.** Each scheduler tick, after execution, the join looks for `waiting` steps that have children (steps whose `parentStepId` points at them). For each such parent it first enforces child deadlines (below), then — once every **required** child is terminal — it:

1. aggregates the children's outputs, ordered by spawn sequence, as `output = { children: [{ index, status, output }, ...] }` (optional children still in flight appear with their current status);
2. transitions the parent to **`completed`** (or **`failed`** if any _required_ child failed), merges the aggregate into the run context, and rolls the parent's own delta into the run metrics — exactly as a normal terminal write would; and
3. **advances** the run from the now-completed parent (`advanceCompletedStep`), so routing proceeds as if the parent had run to completion itself. A failed parent does not advance — mirroring the runner's `failStep` — so the run halts on it for a human to intervene.

## Contract and boundaries

- **`parentStepId` is the discriminator.** A `waiting` step _with_ children is a fan-out parent; a `waiting` step with _no_ children is an external `wait_*` step and the join leaves it untouched. `spawnChildSteps` therefore refuses a zero-child fan-out — a childless `waiting` parent would be indistinguishable from a wait and would never be resumed.
- **Restart-safe by derivation.** The join holds no in-memory state; it re-derives "are all children done?" from persisted child status on every tick. A daemon that crashes mid-join simply re-evaluates and completes the parent on a later tick, and re-running against an already-joined (no longer `waiting`) parent is a no-op. This follows the engine's "derive, don't store" principle, same as the [scheduler's fresh count derivation](event-driven-scheduler.md).
- **Ordering survives restart.** Children are stamped with strictly increasing `createdAt` at spawn, so their `index` in the aggregated output is recoverable from persisted state alone and stable across restarts.
- **Serialized with dispatch.** The join rides the same serialized scheduler tick as admission and execution (`eventScheduler`), so it never races child dispatch or admission and no parent is joined twice.
- **Child policy: optional and deadline (#313).** A `FanOutChildSpec` may set `optional` and/or a spawn-relative `deadlineMs`, persisted on the child as `optional` / `deadlineAt`:
  - **Optional** children never gate the join and their failure is ignored — fire-and-forget side effects (e.g. writing labels once they no longer determine PR status). Left running when the parent joins; they finish on their own.
  - **Deadline** bounds a required child's wait: each tick the join force-terminates any non-terminal child past `deadlineAt` as `skipped` (a non-failure terminal), so "wait up to N for Copilot, then proceed without it" needs no special-casing — the timed-out child becomes `skipped` and the parent completes. Derived from persisted `deadlineAt`, so the bound survives restart.
- **Per-child retry is deferred.** A required child that reaches `failed` fails the parent (halting the run). Automatically re-queuing a failed child that still has retries left (children have no routing of their own to drive a retry) is out of scope; the `github_api` split (#281) and its per-child routing access (#282) build on top.

## Related

- [Step Executor Contract](step-executor-contract.md) — the `ExecutorResult` (now carrying `suspended`) and `StepExecutorRuntime` handle the fan-out parent returns through.
- [Step Advance-on-Completion](step-advance.md) — the join calls it to route the run onward once the parent completes.
- [Execution Tick](execution-tick.md) — drains the child steps; the join runs immediately after it each tick.
- [Event-Driven Scheduler](event-driven-scheduler.md) — the serialized tick the join rides, and the source of the "derive, don't store" pattern.
