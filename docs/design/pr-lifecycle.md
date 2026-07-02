---
type: Design
title: PR Lifecycle — Goal-State Design
description: Target architecture for the per-PR derive → decide → execute lifecycle.
tags: [pr-lifecycle, derivation, gates, design]
---

# PR Lifecycle — Goal-State Design

> **Status**: design / target architecture. Tracked by **[Epic 10 (#92)](https://github.com/rmartz/pr-shepherd/issues/92)**, **[Epic 11 (#93)](https://github.com/rmartz/pr-shepherd/issues/93)**, and **[Epic 12 (#94)](https://github.com/rmartz/pr-shepherd/issues/94)**. Builds on the [vision document (#1)](https://github.com/rmartz/pr-shepherd/issues/1) and the engine described in [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Purpose

PR Shepherd's central job is to drive a pull request from "opened" to "merged" — or to a clearly-recorded parked/failed state — with no human babysitting, across many PRs and repositories concurrently. This document describes the **goal state** of that subsystem: the lifecycle a PR moves through, how the system decides what to do next, and the resilience and orchestration properties the production system must have.

It is written in terms of PR Shepherd's own abstractions — the workflow engine, step executors, routing DSL, and the Firestore data model — not as a port of any prior tool. A CLI proof-of-concept was used to explore the problem space and validate the hard edge cases before this was designed; see [Provenance](#provenance). This document is the target we build to, not a description of that POC.

## 1. Design principles

These four properties are load-bearing; everything below follows from them.

1. **State is derived, not stored.** The system holds no authoritative belief about _where a PR is_. GitHub is the source of truth, re-read each cycle. We persist task _records_ (for retrying, audit, and the UI), but a PR's _position in its lifecycle_ is recomputed from GitHub every cycle. This is what makes the system crash-safe and idempotent by construction: kill it mid-flight, restart, and it resumes exactly where the PR actually is.
2. **Exactly one action per cycle.** For a given PR, each cycle selects a single next action and then yields. The selection function is **total** — every reachable state maps to exactly one action and never falls through to a silent no-op. Silent dead-zones (a state combination that matches no rule, leaving the PR stalled invisibly) are the single largest class of bug this design exists to prevent.
3. **Decision is pure; only execution mutates.** Deriving state and deciding the next action are pure, side-effect-free, and unit-testable in isolation. Only the chosen action touches the world. This separation is the seam the workflow engine is built along.
4. **Every action is idempotent.** Because state is re-derived every cycle, re-running any action is safe: an action that already had its effect produces no new state change, and the next derivation routes the PR onward. This is what lets every step be retryable without bookkeeping.

## 2. The state model — a vector, not a phase

A PR's position is **not** a single linear phase. It is a vector of orthogonal axes, each derived independently, because the underlying conditions are not mutually exclusive — a PR can simultaneously be approved, have CI running, and be awaiting human acceptance testing. Forcing those into one `enum Phase` is precisely what produces dead-zones.

| Axis         | Question it answers                                                  | Values                                                                               |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Review**   | Has a verdict been rendered on the _current_ code?                   | `UNREVIEWED` · `CHANGES_REQUESTED` · `AWAITING_RE_REVIEW` · `APPROVED`               |
| **CI**       | What is CI's verdict on the current HEAD?                            | `NEEDS_AUTH` · `RUNNING` · `PASSED` · `FAILING` · `CANCELLED` · `CANCELLED_RETRIED`  |
| **Conflict** | Can the branch merge cleanly?                                        | `CLEAN` · `CONFLICTING` · `UNKNOWN`                                                  |
| **Copilot**  | Where is the automated reviewer?                                     | `NONE` · `AWAITING_REVIEW` · `HAS_OPEN_THREADS` · `RESOLVED`                         |
| **Threads**  | Are there unresolved review threads?                                 | `NONE_OPEN` · `OPEN`                                                                 |
| **UAT**      | Has human acceptance testing been decided/done?                      | `NOT_REQUIRED` · `DECISION_PENDING` · `READY_UNTESTED` · `TESTED`                    |
| **Hold**     | Is the PR deliberately parked?                                       | `NONE` · `DRAFT` · `WIP` · `DO_NOT_MERGE` · `BLOCKED_ON_ISSUE` · `ESCALATION_NEEDED` |
| **Activity** | Is work in flight or stalled? _(observational only — never decides)_ | `ACTIVE` · `IDLE` · `DELEGATED_WAITING`                                              |

**The "current" subtlety.** Almost every axis is implicitly "…relative to the current HEAD commit." A review only counts if it covers the latest code; CI only counts for the HEAD SHA. Staleness — treating a verdict that was true for an older commit as true now — is the richest source of bugs. Currency is decided by **commit graph position (OID order)**, not author timestamps (which use local clocks and can lie). Derivation is owned by **Epic 10**: a single rate-limited GitHub read ([#95](https://github.com/rmartz/pr-shepherd/issues/95)) feeding pure axis computation ([#96](https://github.com/rmartz/pr-shepherd/issues/96)).

## 3. The decision model — ordered gates

Given the state vector, the next action is chosen by an **ordered list of gates**. Each gate asks "is this prerequisite satisfied?" The **first unsatisfied gate** decides the action; if all pass, the PR merges.

```
NOT_WIP → NO_HOLD → CI_GREEN → NO_CONFLICT → CODE_APPROVED
  → THREADS_RESOLVED → COPILOT_SETTLED → UAT_CLEARED → REVIEWED_BY_SKILL → MERGE
```

The **order is load-bearing**, not cosmetic:

- **Cheap, decisive gates first.** A held or WIP PR is rejected before the system spends a CI-wait cycle on it; resolving a conflict is sequenced before waiting on the automated reviewer. The ordering encodes "don't burn an expensive wait on a PR a later gate will reject anyway."
- **`DO_NOT_MERGE` is a merge-only hold, deliberately last.** A do-not-merge PR should still be reviewed, still run CI, still resolve threads — it just can't take the final merge step. A naive "hold = stop everything" at the top would wrongly freeze all preparatory work.
- **Conflicts can outrank holds.** An escalation/blocked hold is skipped when the branch is also conflicting, because the conflict must resolve regardless.

The decision function is **provably total**: a test enumerates the full product of axis values and asserts exactly one action for every combination. It is built and verified in **Epic 10** ([#98](https://github.com/rmartz/pr-shepherd/issues/98)) and surfaced to workflows as an `evaluate_gates` step ([#100](https://github.com/rmartz/pr-shepherd/issues/100)) whose emitted action the routing DSL branches on.

The actions a gate can demand are the atomic task types: `REVIEW`, `FIX_REVIEW`, `AUTHORIZE_CI`, `RERUN_CI`, `WAIT_CI`, `WAIT_COPILOT`, `WAIT_REMOTE`, `ESCALATE`, `PARK`, `MERGE`.

## 4. The atomic task catalog

Each action is one step in a workflow run — the level at which work is made durable, retryable, and logged. Idempotency is the through-line: every task is safe to re-run.

| Task                     | Triggered when                                                | Effect                                                 | Idempotency / guard                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **derive state**         | start of every cycle                                          | one cached GitHub read → the axis vector; pure         | trivially safe; short-TTL cache, rate-limit backoff                                                                                                                                        |
| **authorize / rerun CI** | CI `NEEDS_AUTH` / `CANCELLED`                                 | approve a queued run, or rerun an infra-cancelled one  | rerun is **one-shot** — a second infra-cancel on the same commit escalates, never loops                                                                                                    |
| **wait CI**              | CI `RUNNING`                                                  | durable wait until CI lands a terminal verdict on HEAD | clears only when _both_ no Actions suite is running _and_ a verdict has landed (a non-Actions status can still be pending)                                                                 |
| **wait Copilot**         | Copilot `AWAITING_REVIEW`                                     | bounded wait (informational, never a hard gate)        | a refusal/outage clears the _wait_ but does not count as a _review_                                                                                                                        |
| **review**               | unreviewed / re-review needed / open threads                  | produce a verdict, reconcile verdict labels atomically | re-running yields a fresh verdict; review never pushes to the branch                                                                                                                       |
| **fix-review**           | changes requested / CI failing on a reviewed PR / conflicting | push commits, resolve addressed threads                | the least idempotent task (mutates the branch) — needs an explicit interrupted-mid-edit story (commit-and-resume)                                                                          |
| **merge**                | all gates satisfied                                           | re-validate against fresh state, then squash-merge     | highest stakes; idempotency key `(pr, headSha)`; globally serialized                                                                                                                       |
| **escalate**             | CI persistently `CANCELLED` (rerun spent)                     | apply sticky `escalation needed`, strip other verdicts | applied once — the resulting hold parks the next tick at `NO_HOLD` before CI is re-checked; clearing the label re-enters review ([#253](https://github.com/rmartz/pr-shepherd/issues/253)) |
| **park**                 | any hold                                                      | stop with a recorded reason                            | a no-op that **auto-resumes** when its cause clears (issue closes, label removed) — never manually un-parked                                                                               |

## 5. How the lifecycle maps onto the workflow engine

The lifecycle is expressed as **configurable workflow definitions** over the existing engine (scheduler, runner, routing DSL, step executors), not as bespoke control flow:

- **`derive_pr_state` step** ([#97](https://github.com/rmartz/pr-shepherd/issues/97)) runs the derivation and writes the flat axis vector into the run's `context`, so the routing DSL can branch on `context.state.ciState == 'passed'` and the like.
- **`evaluate_gates` step** ([#100](https://github.com/rmartz/pr-shepherd/issues/100)) runs the total decision function and emits `{ action, blockingGate }`; the workflow's routing rules map each action to a concrete next step. This keeps the _decision logic_ in typed, totality-tested code while keeping the _wiring_ (which gate → which step) configurable in YAML.
- **Capability isolation.** Only `github_api` steps may mutate GitHub. `claude_skill` steps produce structured output describing intended GitHub actions; a paired `github_api` step performs them. The `claude_skill` executor enforces this structurally — it spawns the subprocess with GitHub credentials redacted — so there is no convention-based path around the GitHub-API queue.
- **Concurrency dimensions** are unchanged: a global Claude cap, an independent global GitHub-API cap (to prevent 429 / secondary-rate-limit storms), and a per-repo cap — applied per step type.
- **Workflows.** `base-pr`, `dependabot-pr`, and `dependabot-fix` ([#102](https://github.com/rmartz/pr-shepherd/issues/102) / [#103](https://github.com/rmartz/pr-shepherd/issues/103)) are authored as `derive → gates → {review / fix / merge / wait_*}` graphs that loop back to `derive_pr_state` after each effectful step (re-derive every cycle — never trust a stored phase). These replace the vision's `pr-delegate.py` triage placeholder.

## 6. Orchestration & resilience at scale

The per-PR lifecycle (§2–§5) runs for many PRs concurrently. The cross-PR layer (**Epic 11**) governs that:

- **Bounded worker pool, one action per slice.** Each work slice runs a single action and yields, so no PR monopolizes a worker and none starves.
- **Wait-sets, not held workers.** PRs waiting on CI or Copilot move to wait-sets drained by one shared bulk poll, rather than each holding a worker on a sleep ([#110](https://github.com/rmartz/pr-shepherd/issues/110)).
- **Merge serialization.** Merges happen one at a time through a single path with an idempotency key, concurrently with — but separate from — review/fix work ([#104](https://github.com/rmartz/pr-shepherd/issues/104)). Only one PR can win a fast-forward race, and serializing keeps `main` observable one change at a time.
- **Convergence is judged, not counted.** Fix→review loops are caught by a periodic progress assessment (converging vs flapping) rather than a hard round cap, so genuinely large PRs aren't punished and obvious flappers still escalate ([#105](https://github.com/rmartz/pr-shepherd/issues/105)). A same-action loop detector stops spins where an action runs and routes straight back to itself with no state change.
- **Automated-reviewer request ladder.** The automated reviewer is requested at a few precise moments (warmup, at approval, and a merge-time double-check) to collapse the latency between "approved" and "ready to merge," with a refusal treated distinctly from a real review ([#106](https://github.com/rmartz/pr-shepherd/issues/106)).
- **Circuit breakers.** Two queue-halting gates: don't dispatch work whose CI can't validate it (CI budget exhausted), and quarantine everything except the designated fix when `main` is broken ([#107](https://github.com/rmartz/pr-shepherd/issues/107)).
- **Self-discovery.** The routable PR set is recomputed each cycle, not held as a fixed list; newly-eligible PRs are enrolled into runs ([#108](https://github.com/rmartz/pr-shepherd/issues/108)).
- **Self-observability.** Every task emits a structured record (inputs, status, attempts, logs, outcome); a post-run analysis surfaces recurring anomalies ([#109](https://github.com/rmartz/pr-shepherd/issues/109)).

## 7. Resilience model

- **Crash recovery on startup** reconciles persisted step state with reality: demote orphaned `queued` steps, classify stale `running` steps, fail orphaned runs.
- **Heartbeat recovery** catches hung/dead steps mid-run and re-enqueues them within the retry budget.
- **Idempotency guards** make every effectful step safe to re-run, and **settle windows** after label-writing actions absorb GitHub's eventual consistency so a not-yet-visible label write isn't misread as "the action did nothing."
- **Fail open vs fail safe** is chosen per check: a transient lookup failure must not make a healthy PR look stuck (fail open); an unresolvable blocking-issue lookup keeps the PR parked (fail safe).

## 8. Evolution: polling → webhooks

The initial production system triggers derivation on a fixed cadence — the scheduler tick plus wait-set bulk polls — which is robust and crash-safe but higher-latency and API-heavier than necessary. Once the polling-based lifecycle is proven end-to-end, **Epic 12** swaps the _trigger_: GitHub webhooks drive derivation precisely when state changes. Crucially this is a trigger swap, not a lifecycle rewrite — the derive → decide → execute core is reused unchanged, and its idempotency is exactly what makes at-least-once, out-of-order webhook delivery safe. A slow reconciliation poll is retained as a safety net; correctness never depends on webhooks alone.

## 9. Epic map

| Epic                                     | Scope                                                                                                                                                 | Issue                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Epic 10 — Derivation & Gates**         | State snapshot, 8-axis derivation, total gate model, atomic-task guards, `base-pr` / `dependabot` workflows                                           | [#92](https://github.com/rmartz/pr-shepherd/issues/92) |
| **Epic 11 — Orchestration & Resilience** | Merge serialization, convergence assessment, reviewer request ladder, circuit breakers, self-discovery, self-observability, wait-sets / stall defense | [#93](https://github.com/rmartz/pr-shepherd/issues/93) |
| **Epic 12 — Webhook-Driven Triggering**  | Webhook receiver, event → derivation mapping, dedup / ordering / replay, polling fallback                                                             | [#94](https://github.com/rmartz/pr-shepherd/issues/94) |

**Critical-path prerequisites** (existing work these build on): the `claude_skill` executor ([#61](https://github.com/rmartz/pr-shepherd/issues/61)); the workflow YAML + config loader and PR discovery/enrollment ([Epic 5, #8](https://github.com/rmartz/pr-shepherd/issues/8)); the executor heartbeat/waiting contract ([#78](https://github.com/rmartz/pr-shepherd/issues/78)); and the heartbeat monitor ([#58](https://github.com/rmartz/pr-shepherd/issues/58)).

## Provenance

The lifecycle, state axes, gate ordering, and the catalogue of GitHub edge cases in this document were validated by a CLI proof-of-concept before being designed into PR Shepherd. That POC is not the architecture — it explored the problem space and surfaced the hard cases that any production system on the GitHub API must handle: commit-graph currency (not author timestamps), the GitHub-Actions-vs-commit-status CI split, automated-reviewer refusal-vs-review, eventual-consistency label lag, and the dead-zone failure mode that motivates a _total_ decision function. PR Shepherd is the productionalized solution built from those learnings; this document is its target state.
