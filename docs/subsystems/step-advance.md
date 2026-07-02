---
type: Subsystem
title: Step Advance-on-Completion
description: When a step completes, evaluate its routing and create the next step (or finish the run) — the wiring that turns the routing DSL into a running workflow.
resource: src/engine/advance
tags: [engine, execution-loop, routing, workflow]
---

# Step Advance-on-Completion

`advanceCompletedStep(step, deps)` is the seam that makes a workflow actually _progress_. When a step reaches `completed`, its workflow definition's routing rules decide what runs next — and until this landed, nothing evaluated them: `evaluateRouting` had no production caller, so a completed step never produced a successor. This is **part 1 of the execution loop** (#284).

## What it does

1. Loads the run and its [workflow graph](../workflows/base-pr.md) (via an injected `getGraph` resolver — production wires the `WorkflowRegistry`).
2. Finds the completed step's definition (`stepDefinitionId`) and evaluates its `routing` rules against `{ output: step.output, context: run.context }` with the [routing DSL](../../src/engine/routing/evaluate.ts). The run's `context` is read fresh — the runner merges a step's output into the run context _before_ this runs, so conditions may read either `output.*` or the accumulated `context.*`.
3. **Routed to a next step** → creates the next `pending` `stepInstance` (mirroring how enrollment seeds the first step: the definition's `input` is stored **verbatim**; `{{ context.* }}` interpolation is a dispatch-time concern), and points `run.currentStepId` at the new **instance** id.
4. **Terminal route** (`next: null`) → marks the run `completed` and clears `currentStepId`.

## Contract and boundaries

- **Invoked once per completion.** This is not a self-guarding idempotent primitive; the dispatch half (part 2) calls it in the runner-completion continuation and owns crash-replay reconciliation (re-advancing a completed step whose successor was never created). A defensive status check still skips a non-completed step so a misinvocation cannot fabricate a successor.
- **`currentStepId` is an instance id.** Crash recovery resolves `currentStepId` against the step-instance collection, so the advance sets it to the new step's instance id (not its definition id).
- **Dispatch is the companion half.** Picking up `queued` steps, running them through the runner, and invoking this on completion is tracked as #284 part 2 — it entangles with the production executor registry.

## Related

- [Step Executor Contract](step-executor-contract.md) — the runner ↔ executor contract whose terminal completion triggers the advance.
- [Event-Driven Scheduler](event-driven-scheduler.md) — admits `pending → queued`; the advance produces the `pending` steps it admits.
- [base-pr workflow](../workflows/base-pr.md) — the routing graph the advance walks each tick.
