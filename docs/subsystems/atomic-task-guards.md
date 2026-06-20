---
type: Subsystem
title: Atomic-Task Guards
description: The pure cross-cutting guards that make atomic tasks safe to re-run — one-shot rerun, settle windows, idempotency keys, verdict-label reconciliation.
resource: src/engine/guards
tags: [lifecycle, guards, idempotency, resilience]
---

# Atomic-Task Guards

The lifecycle executes **exactly one atomic action per cycle, idempotent by construction** (see the [PR-lifecycle design](../design/pr-lifecycle.md) §4, §6, §7). The guards in `src/engine/guards` are the cross-cutting, pure decisions that make those actions safe to re-run — each closes a specific recurring bug. Like the [gate model](gate-model.md), every guard is a deterministic transformation (state in → decision out) with no I/O and no clock reads, so the effectful executor stays a thin wrapper and the guards are exhaustively unit-testable.

## One-shot rerun guard

`rerunGuard(headOid, ledger)` decides whether an infra-cancelled CI run may be rerun. A commit gets **exactly one** automated rerun: the first infra-cancel yields `Rerun`, a second on the _same_ commit yields `Escalate` — so a flapping infra cancel can never spin the `RERUN_CI` action against itself (the same-action loop). A new HEAD commit resets the budget. `recordRerun` returns an updated `(commit → count)` ledger without mutating the input. This pairs with the gate model's `CANCELLED → RERUN_CI` / `CANCELLED_RETRIED → PARK` routing: the guard is the upstream decision the derivation uses to choose between those two CI axes.

## Settle window

`settleGuard(input)` absorbs GitHub's eventual-consistency lag after a label-writing action (e.g. `/review` applying a verdict). When the next observation is unchanged, the guard returns `Settle` — wait once (`DEFAULT_SETTLE_MS`), re-derive, and only then conclude. A still-unchanged recheck (the one shot spent) returns `Unchanged`; a visible change returns `Changed`. This stops a ~1–2 s label-propagation delay from being misread as "the action changed nothing", which the same-action loop detector would otherwise treat as a failure to progress.

## Idempotency keys

`idempotencyKey(target, action)` derives the stable `(owner, repo, prNumber, headSha, action)` key for a mutating step; `isAlreadyApplied(target, action, applied)` checks it against the set of spent keys built from durable task records. `headSha` is part of the key because a new commit is a genuinely new action — a `MERGE` of commit A and a `MERGE` of commit B are distinct, and a push that moves HEAD must be allowed to re-run. The highest-stakes caller is `merge`: a duplicate merge attempt on the same HEAD is recognised and skipped.

## Atomic verdict-label reconciliation

The verdict labels — `approved`, `changes requested`, `review requested`, `escalation needed` — are mutually exclusive. `reconcileVerdict(verdict, labels)` computes the single atomic `LabelMutation` (add the chosen verdict, remove every other) so there is no intermediate state where the PR carries two verdicts; non-verdict labels (domain labels) are untouched. `healVerdict(labels)` repairs a PR already carrying two or more contradictory verdicts, keeping the highest-precedence one (`escalation needed` > `changes requested` > `review requested` > `approved`) so a contradiction resolves _away_ from a spurious `approved`.

## Public API

Exported from `src/engine/guards` (`index.ts`): `rerunGuard` / `recordRerun` / `RerunVerdict` / `MAX_RERUNS_PER_COMMIT` / `RerunLedger`; `settleGuard` / `SettleVerdict` / `SettleInput` / `DEFAULT_SETTLE_MS`; `idempotencyKey` / `isAlreadyApplied` / `IdempotencyTarget` / `AppliedKeys`; `reconcileVerdict` / `healVerdict` / `VerdictLabel` / `LabelMutation`.

## Related

- [Gate Model](gate-model.md) — the `decide` function whose `RERUN_CI` / `PARK` routing the rerun guard feeds.
- [PR State Derivation](pr-state-derivation.md) — produces the state vector and the HEAD OID the guards key on.
