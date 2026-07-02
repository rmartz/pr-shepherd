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

| Pre-merge readiness            | Outcome                                             |
| ------------------------------ | --------------------------------------------------- |
| `Ready` → merge succeeds       | `Merged` (key recorded)                             |
| `Ready` → merge throws         | `Failed` / `Escalated` — see the retry budget below |
| `CiRunning` / `CopilotPending` | `Deferred` — re-poll later                          |
| `CiFailed` / `Conflicting`     | `Rejected` — kicked to fix-review                   |

The re-validation and the side-effecting merge/kickback are injected, so the coordinator is pure to test and the actual GitHub mutation still flows through the `github_api` queue (capability isolation).

## Merge-failure retry budget

A merge that throws is not blindly retried forever. When the optional `budget` seam is wired, the coordinator classifies the failure ([`classifyMergeError`](../../src/engine/merge/errorClassification.ts)) and routes it (#252):

- **Operator-actionable** (missing `workflow` scope, bad credentials, missing permission, unauthorized SSO) — can never succeed on a retry. Escalate **immediately**: apply sticky `escalation needed`, no budget spent → `Escalated`.
- **Transient** (rate-limit blip, mergeability race, persistent branch protection) — counted against a **durable per-(PR, head SHA) budget**. Below `ESCALATION_THRESHOLD` (3): record a marker and defer (`Failed`, kicked to fix-review). At the threshold: apply sticky `escalation needed` and record a repeated-failure ledger occurrence → `Escalated`.

The count is durable because each failure is a hidden marker comment on the PR itself ([`attemptLedger`](../../src/engine/merge/attemptLedger.ts)), so it survives a daemon restart. Keying by head SHA gives the reset signals: a **new commit** starts a fresh count, and a human **clearing `escalation needed`** discounts markers older than the removal (a server-side fix with no push). Once escalated, the `escalation needed` hold makes the [Gate Model](gate-model.md) park the PR, so it is never re-selected for merge until the label clears. The marker read/write and label mutation are injected (like `revalidate` / `merge`), keeping the coordinator pure; production wires them through the `github_api` queue.

## Pre-merge re-validation

`assessMergeReadiness(state)` re-derives the volatile axes immediately before merging — the ones that drift between the gate decision and the merge. It distinguishes **CI still running** (defer, re-poll) from **CI failed** (kick to fix), and confirms no conflict and Copilot settled. Review/hold/UAT are the [Gate Model](gate-model.md)'s domain, already satisfied when a PR reaches the merge path.

## Branch currency

`needsBranchSync(...)` encodes that **behind-`main` is not itself a blocker**: a behind-but-clean branch merges as-is. A sync is required only on overlapping files, a breaking change, or any drift on a dependency-lockfile PR (the stricter case).

## Related

- [Gate Model](gate-model.md) — decides a PR is merge-ready before it reaches here.
- [Atomic-Task Guards](atomic-task-guards.md) — the broader idempotency/guard primitives this complements.
