---
type: Subsystem
title: Merge Serialization
description: A single global merge path — one merge at a time, idempotent on (pr, headSha), with pre-merge re-validation.
resource: src/engine/merge
tags: [lifecycle, merge, resilience, idempotency]
---

# Merge Serialization

Merging is the highest-stakes, most propagation-lag-exposed task. This module makes it a **single global path**: at most one merge in flight across all PRs, so only one can win a fast-forward race and `main` advances one observable step at a time.

## Coordinator

`createMergeCoordinator()` holds two pieces of in-process state:

- A **mutex** — `attemptMerge` returns `Skipped` if a merge is already in flight (the flag is held across the whole attempt, including its awaits).
- A **merged set** keyed by `(repo, pr, headSha)` — the **idempotency key**. A crash-after-merge retry at the same HEAD is a no-op (`Skipped`), and a just-merged PR isn't re-acted on while GitHub's propagation lags. A new commit changes `headSha`, so the PR becomes eligible again.

`attemptMerge` re-validates, then routes:

| Pre-merge readiness            | Outcome                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `Ready` → merge succeeds       | `Merged` (key recorded)                                   |
| `Ready` → merge throws         | `Failed` — kicked to fix-review, **not** retried in place |
| `CiRunning` / `CopilotPending` | `Deferred` — re-poll later                                |
| `CiFailed` / `Conflicting`     | `Rejected` — kicked to fix-review                         |

The re-validation and the side-effecting merge/kickback are injected, so the coordinator is pure to test and the actual GitHub mutation still flows through the `github_api` queue (capability isolation).

## Pre-merge re-validation

`assessMergeReadiness(state)` re-derives the volatile axes immediately before merging — the ones that drift between the gate decision and the merge. It distinguishes **CI still running** (defer, re-poll) from **CI failed** (kick to fix), and confirms no conflict and Copilot settled. Review/hold/UAT are the [Gate Model](gate-model.md)'s domain, already satisfied when a PR reaches the merge path.

## Branch currency

`needsBranchSync(...)` encodes that **behind-`main` is not itself a blocker**: a behind-but-clean branch merges as-is. A sync is required only on overlapping files, a breaking change, or any drift on a dependency-lockfile PR (the stricter case).

## Related

- [Gate Model](gate-model.md) — decides a PR is merge-ready before it reaches here.
- [Atomic-Task Guards](atomic-task-guards.md) — the broader idempotency/guard primitives this complements.
