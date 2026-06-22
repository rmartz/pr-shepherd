---
type: Workflow
title: dependabot-pr
description: The PR lifecycle workflow for Dependabot PRs — reuses base-pr's derive → gates spine, layering mergeable / spawn-fix / rebase classification on the same gate decision.
resource: workflows/dependabot-pr.yaml
tags: [workflow, pr-lifecycle, dependabot, derivation, gates, routing]
---

# `dependabot-pr` workflow

Drives one Dependabot pull request from "opened" toward "merged" — or to a recorded parked/failed state. It reuses the [`base-pr`](base-pr.md) workflow's `derive_pr_state → evaluate_gates` spine and its shared `review` / `merge` / `wait_*` / CI-mutation steps verbatim, then layers the three Dependabot-specific classification branches on top of the **same** pure [gate decision](../subsystems/gate-model.md).

It implements the Dependabot lifecycle in [PR Lifecycle — Goal-State Design §5.2](../design/pr-lifecycle.md).

## Classification

Every branch is decided by the pure `evaluate_gates` step — no Dependabot-specific logic leaks into the decision; only the routing differs from `base-pr`.

| Condition (PR is…)       | gate `Action` (+ `blockingGate`) | route                                                                        |
| ------------------------ | -------------------------------- | ---------------------------------------------------------------------------- |
| mergeable                | `merge` / `review`               | `merge` / `review` → re-derive (the base-pr fast-path)                       |
| ci-failing & fixable     | `fix_review` (`ci_green`)        | `spawn_fix_pr` → `wait_fix_pr` → `rebase_dependabot` → `wait_ci` → re-derive |
| conflicting              | `fix_review` (`no_conflict`)     | `rebase_dependabot` → `wait_ci` → re-derive                                  |
| ci-failing & not-fixable | `park`                           | _terminal_ (ends the tick)                                                   |

The conflict-driven and CI-driven fix branches both surface as `action == 'fix_review'`; they are disambiguated by `output.blockingGate` (`no_conflict` vs `ci_green`), with the most-specific rules ordered first. A conflicting Dependabot branch is fixed by `@dependabot rebase`, **not** a Claude fix — Dependabot owns the branch — so the conflict path rebases while the CI-failure path forks a fix child.

## The fix-child fan-out

A CI failure on a Dependabot PR is repaired in a child run, not in-place:

1. **`spawn_fix_pr`** (`fork` executor) forks the [`dependabot-fix`](dependabot-fix.md) workflow against this PR, linking child to parent.
2. **`wait_fix_pr`** (`wait_external`, `kind: fix_pr`) durably waits on the fix PR's CI without holding a Claude slot.
3. **`rebase_dependabot`** asks Dependabot to rebase onto the fixed base.
4. **`wait_ci`** waits for fresh CI, then routes back to `derive_pr_state` so the next action is chosen from a freshly-read state.

## The rebase marker idiosyncrasy

The `rebase_dependabot` step dispatches a `rebase_dependabot` `github_api` action whose `rebaseInProgress` param carries the derived marker `context.state.dependabotRebase == 'in_progress'`. The "Dependabot is rebasing this PR" body line is **authoritative and current**: while it is present the executor no-ops instead of posting a redundant `@dependabot rebase` command (Dependabot re-rebases automatically when `mergeable` flips). The guard rides on the action params rather than a `post_comment` so it survives routing — see the [dependabot rebase axis](../subsystems/pr-state-derivation.md).

## Related

- [`base-pr`](base-pr.md) — the spine and shared steps this workflow reuses.
- [`dependabot-fix`](dependabot-fix.md) — the child workflow `spawn_fix_pr` forks.
- [PR Lifecycle — Goal-State Design](../design/pr-lifecycle.md) — §5.2 Dependabot lifecycle.
- [Gate Model](../subsystems/gate-model.md) — the total `decide()` whose `Action` / `blockingGate` the routing branches on.
