---
type: Workflow
title: base-pr
description: The central PR lifecycle workflow — derive → gates → {review / fix / merge / wait_*}, re-deriving every tick.
resource: workflows/base-pr.yaml
tags: [workflow, pr-lifecycle, derivation, gates, routing]
---

# `base-pr` workflow

The central workflow that drives one pull request from "opened" toward "merged" — or to a recorded parked/failed state — with no human babysitting. It is the productionized replacement for the vision's `pr-delegate.py` triage placeholder, expressed entirely as a [workflow definition](../../workflows/base-pr.yaml) over the existing engine (scheduler, runner, routing DSL, step executors).

It implements the goal-state lifecycle in [PR Lifecycle — Goal-State Design](../design/pr-lifecycle.md): **state is derived, not stored**; **exactly one action per cycle**; **decision is pure, only execution mutates**; **every action is idempotent**.

## Shape

```
derive_pr_state → evaluate_gates → { review / fix_review / merge /
                                     wait_ci / wait_copilot_review /
                                     wait_author_push / authorize_ci /
                                     rerun_ci / escalate / park }
```

Every effectful step (each `github_api` poster and each wait) routes back to `derive_pr_state`, so the next action is always chosen from a freshly-read state vector — a stored phase is never trusted.

## The tick

1. **`derive_pr_state`** ([executor](../steps/derive-pr-state.md)) performs one rate-limited GitHub read and writes the flat 8-axis [state vector](../subsystems/pr-state-derivation.md) to `context.state`.
2. **`evaluate_gates`** ([executor](../steps/evaluate-gates.md)) runs the provably-total [gate decision](../subsystems/gate-model.md) over `context.state` and emits `{ action, blockingGate }`. It is dispatched as a `decision`-type step, so it consumes no Claude / GitHub-API / per-repo slot.
3. The routing rules branch on `output.action`, mapping each gate `Action` to one concrete step:

   | `output.action` | next step             | kind                                |
   | --------------- | --------------------- | ----------------------------------- |
   | `review`        | `review`              | claude_skill → post_review          |
   | `fix_review`    | `fix_review`          | claude_skill → post_fix_review_acks |
   | `merge`         | `merge`               | claude_skill → post_merge           |
   | `wait_ci`       | `wait_ci`             | wait_external                       |
   | `wait_copilot`  | `wait_copilot_review` | wait_external                       |
   | `wait_remote`   | `wait_author_push`    | wait_author_push                    |
   | `authorize_ci`  | `authorize_ci`        | github_api                          |
   | `rerun_ci`      | `rerun_ci`            | github_api                          |
   | `escalate`      | `escalate`            | github_api                          |
   | `park`          | _terminal_            | (ends the tick)                     |

   Every `Action` is handled explicitly so no derived action falls into a silent dead-zone; the trailing `condition: "true"` is the routing DSL's required catch-all and parks defensively.

## Capability isolation

Only `github_api` steps mutate GitHub. Each Claude skill (`review`, `fix_review`, `merge`) emits structured intent — a batch of GitHub actions on `output.actions` — that its paired `github_api` step (`post_review`, `post_fix_review_acks`, `post_merge`) carries out. The [`claude_skill`](../steps/claude-skill.md) executor spawns the subprocess with GitHub credentials scrubbed, so a skill physically cannot push; the pairing is what makes the global GitHub-API concurrency cap meaningful.

## Parking

A hold (draft, WIP, do-not-merge, blocked-on-issue, escalation) yields `action: park`, which routes to a terminal `next: null`. The run ends for this tick and auto-resumes on the next scheduled cycle when its cause clears — parks are never manually un-parked.

## Escalation

Persistently-cancelled CI (`CancelledRetried`, the one-shot rerun already spent) does not silently re-park. `evaluate_gates` yields `action: escalate` and, alongside it, the concrete `add_label` / `remove_label` batch (`output.escalationActions`) that makes `escalation needed` the PR's sole verdict label. The `escalate` `github_api` step applies it and re-derives. The relabel is applied exactly once — the resulting `escalation needed` hold parks the run at the `NoHold` gate on the next tick — and clearing the label (after a human fixes the run) returns the PR to normal review routing. See the [evaluate_gates escalation output](../steps/evaluate-gates.md#escalation-output) and [#253](https://github.com/rmartz/pr-shepherd/issues/253).

## Related

- [PR Lifecycle — Goal-State Design](../design/pr-lifecycle.md) — the lifecycle, state vector, and gate ordering this workflow encodes.
- [`derive_pr_state`](../steps/derive-pr-state.md) · [`evaluate_gates`](../steps/evaluate-gates.md) · [`claude_skill`](../steps/claude-skill.md) — the executors the steps dispatch.
- [Gate Model](../subsystems/gate-model.md) — the total `decide()` whose `Action` the routing branches on.
