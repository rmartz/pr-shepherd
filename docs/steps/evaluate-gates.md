---
type: StepExecutor
title: evaluate_gates
description: Reads the derived state vector, runs the gate decision, and emits { action, blockingGate } for the routing DSL.
resource: src/steps/evaluateGates.ts
tags: [steps, gates, decision, routing]
---

# `evaluate_gates` step executor

A zero-cost (decision-type) step that bridges the typed [Gate Model](../subsystems/gate-model.md) into the configurable workflow YAML. It reads the derived `PrStateVector` from its `input.state`, runs the provably-total `decide()`, and emits `{ action, blockingGate }` as its output so the routing DSL can branch on `output.action`.

This is the seam that keeps the _routing_ configurable in YAML while the _decision_ stays in typed, exhaustively-tested TS: the executor owns no gate logic — it parses input, delegates to `decide`, and shapes output.

## Input contract

The step's `input` carries the state vector (and optional pure `decide` options) hoisted from the run context:

- `input.state` — the `PrStateVector` produced by the [`derive_pr_state`](../subsystems/pr-state-derivation.md) step and written to `context.state`. The runner merges each step's output into the run context, so by the time this step is queued the preceding derivation's `{ state }` output is on `context.state`; the workflow definition maps `context.state` into this step's `input.state`.
- `input.options` (optional) — `{ copilotUnavailable?, skipUat? }`, the pure `DecideOptions` flags forwarded to `decide()`.

Malformed input (missing/invalid state vector) rejects the step, which the runner records as a failed step.

## Output and routing contract

Output is `{ action, blockingGate }` — plus `escalationActions` on an `escalate` decision (see below). A downstream routing step maps each `Action` to a concrete next step; the routing DSL requires a `condition: "true"` catch-all as the final rule:

| `output.action`    | next step      |
| ------------------ | -------------- |
| `review`           | `review`       |
| `fix_review`       | `fix_review`   |
| `merge`            | `merge`        |
| `wait_ci`          | `wait_ci`      |
| `authorize_ci`     | `authorize_ci` |
| `rerun_ci`         | `rerun_ci`     |
| `wait_copilot`     | `wait_copilot` |
| `wait_remote`      | `wait_remote`  |
| `escalate`         | `escalate`     |
| `park`             | `park`         |
| `true` (catch-all) | required       |

## Escalation output

When `decide()` returns `escalate` — CI is persistently cancelled (`CancelledRetried`) after the one-shot rerun was spent — the step also emits `output.escalationActions`: the concrete `add_label` / `remove_label` batch that `reconcileVerdict(EscalationNeeded, labels)` computes to make `escalation needed` the PR's sole verdict label (any present `approved` / `changes requested` / `review requested` is stripped). The paired `escalate` `github_api` step applies it. Building this needs the PR's raw `labels`, `repo`, and `pr`, which the workflow supplies as extra `evaluate_gates` inputs. `repo`/`pr` are schema-optional (a workflow that never routes escalation omits them) but **required at runtime on an escalate decision** — the executor throws if either is missing rather than silently emitting no `escalationActions`, so a misconfigured workflow fails visibly ([#277](https://github.com/rmartz/pr-shepherd/issues/277)). The relabel lands exactly once: the applied `escalation needed` hold makes the next tick park at the `NoHold` gate before CI is re-checked, and clearing the label (after a human fixes the run) returns the PR to normal review routing. See [#253](https://github.com/rmartz/pr-shepherd/issues/253).

## Cost model

The step runs in-process and consumes no Claude / GitHub-API / per-repo slot. It is dispatched as a `decision`-type step, which `canAdmitStep` admits unconditionally (`countsAgainstRepo` returns `false` for `decision`).

## Public API

Exported from `src/steps/evaluateGates.ts`: `evaluateGatesExecutor`, `EvaluateGatesInputSchema`, and the `EvaluateGatesInput` type.

## Related

- [Gate Model](../subsystems/gate-model.md) — the total `decide()` this executor calls.
- [PR State Derivation](../subsystems/pr-state-derivation.md) — produces the `context.state` this executor reads.
