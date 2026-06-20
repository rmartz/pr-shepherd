---
type: Subsystem
title: Gate Model
description: The pure, total decision — a PrStateVector walks an ordered gate table to exactly one Action.
resource: src/engine/gates
tags: [lifecycle, gates, decision, totality]
---

# Gate Model

The gate model is the **decide** half of the lifecycle's derive → decide → execute loop (see [ARCHITECTURE.md](../../ARCHITECTURE.md) and the [PR-lifecycle design](../design/pr-lifecycle.md) §3). `decide(state, opts?)` takes the [`PrStateVector`](pr-state-derivation.md) produced by derivation and returns the single next `Action` — with no I/O and no clock reads, so it is fully reproducible and unit-testable.

## The ordered gate table

`decide` walks a fixed priority order of gates. Each gate asks "is this prerequisite satisfied?"; the **first unsatisfied gate decides the action**. If every gate passes, the PR merges.

```
NOT_WIP → NO_HOLD → CI_GREEN → NO_CONFLICT → CODE_APPROVED
  → THREADS_RESOLVED → COPILOT_SETTLED → UAT_CLEARED → REVIEWED_BY_SKILL → MERGE
```

The order is **load-bearing**: cheap decisive gates run first so an expensive CI/Copilot wait is never spent on a PR a later gate would reject anyway.

## Ordering invariants

- **`DO_NOT_MERGE` is a merge-only hold.** It is enforced at the terminal `MERGE` gate, not at the top — a do-not-merge PR still reviews, runs CI, and resolves threads; it just cannot take the final merge step (it `PARK`s there).
- **`NO_HOLD` is skipped when CONFLICTING.** An escalation / blocked-on-issue hold does not park a conflicting branch, because the conflict must resolve regardless — control falls through to the `NO_CONFLICT` gate.
- **A never-reviewed CI-failing PR routes to `REVIEW`, not `FIX_REVIEW`.** Fixing presupposes a verdict to fix against; an unreviewed PR gets a first review.
- **New commits strip a standing `APPROVED`** (the derivation sets `review` to `AWAITING_RE_REVIEW`), so the `CODE_APPROVED` gate re-routes to `REVIEW`.

## Actions and options

The closed `Action` set is the atomic task catalog (design doc §4): `REVIEW`, `FIX_REVIEW`, `AUTHORIZE_CI`, `RERUN_CI`, `WAIT_CI`, `WAIT_COPILOT`, `WAIT_REMOTE`, `PARK`, `MERGE`. `decide` returns a `GateDecision = { action, blockingGate }` so the caller knows _which_ gate demanded the action.

Two data-only `DecideOptions` flags relax gates: `copilotUnavailable` satisfies `COPILOT_SETTLED` (a reviewer refusal/outage clears the _wait_, never a hard gate), and `skipUat` satisfies `UAT_CLEARED`.

## Totality

The decision is **provably total**: every reachable axis combination maps to exactly one action and never throws or falls through. Silent dead-zones — a state combination that matches no rule, stalling a PR invisibly — are the bug class this design exists to eliminate. `gates-tests/totality.spec.ts` enumerates the full cartesian product of all axis values (across every `DecideOptions` combination) and asserts a defined action for each.

## Merge-candidate arbitration

`decide` marks **every** merge-ready PR with `Action.Merge`, but merges are globally serialized (design doc §6; [#104](https://github.com/rmartz/pr-shepherd/issues/104)) — only one PR may merge per pass. `selectMergeCandidate(candidates)` is the pure tie-break that picks that single winner, or returns `undefined` when no candidate is merge-eligible.

It is the same shape as `decide`: pure (no I/O, no clock reads), total, and unit-testable. Each `Candidate` is the minimal projection arbitration reads — `{ prNumber, action, priority, changedFiles, createdAt }`. The ordering is:

1. **Eligibility** — only candidates whose `action` is `Action.Merge` are considered.
2. **Priority class** (`MergePriority`, ranked by `MERGE_PRIORITY_RANK`) — `Hotfix` → `DependabotFix` → `Normal` → `Dependabot`. A hotfix unblocks a broken `main`; a Dependabot-fix unblocks the Dependabot PR it repairs, so both jump ahead of ordinary PRs (Coordinator spec §3).
3. **Most files changed** — within a class, the largest PR merges first to clear the most blocking surface area.
4. **Oldest `createdAt`**, then **lowest `prNumber`** — a total tie-break so the result never depends on input ordering.

## Public API

Exported from `src/engine/gates` (`index.ts`): `decide`, the `Action` and `Gate` enums, the `GateDecision` / `DecideOptions` types, and the arbitration surface — `selectMergeCandidate`, the `MergePriority` enum, and the `Candidate` type.

## Related

- [PR State Derivation](pr-state-derivation.md) — produces the `PrStateVector` `decide` consumes.
- The `evaluate_gates` step ([#100](https://github.com/rmartz/pr-shepherd/issues/100)) surfaces `decide` to workflows; the routing DSL branches on the emitted action.
