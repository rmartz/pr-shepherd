---
type: StepExecutor
title: derive_pr_state
description: Fetches the run's PR snapshot, derives the 8-axis state vector, and exposes it at context.state.
resource: src/steps/derivePrState.ts
tags: [steps, derivation, github, read-only, gates]
---

# `derive_pr_state` step executor

Fetches one rate-limited [PR snapshot](../subsystems/pr-state-derivation.md) for the run's PR, derives the flat 8-axis `PrStateVector`, and returns it as `{ state, labels }`. The runner shallow-merges step output into `workflowRun.context`, so the vector becomes readable at `context.state` — exactly what the routing DSL and the gate step branch on (`context.state.ci == "passed"`, `context.state.review == "approved"`, …). The raw `labels` list is surfaced alongside at `context.labels` so a downstream step can compute an exact label mutation without a re-fetch — `evaluate_gates` uses it to build the escalation relabel ([#253](https://github.com/rmartz/pr-shepherd/issues/253)); the derived axes deliberately do not carry raw labels. This is the step that replaces the vision's `pr-delegate.py` triage placeholder.

## Inputs

The executor takes no step `input`. It reads the PR target from the run itself: `workflowRun.repo` (split into `owner`/`name`) and `workflowRun.prNumber`. A missing run, or a `repo` not in `owner/name` form, throws.

## Capability isolation (hard rule)

The executor is **read-only**. It holds a `GithubReadTransport` whose only operations are `graphql` and `restPaginate` — it never performs a GitHub mutation. All mutation flows through the separate `github_api` step queue.

## Concurrency

Because it performs a GitHub read, `derive_pr_state` counts against both the **per-repo** concurrency dimension and the global **GitHub-API** dimension (`systemGithubApi`), alongside `github_api`. This keeps it inside the shared budget that guards against 429 / secondary-rate-limit storms.

## Public API

Exported from `src/steps/derivePrState.ts`: `createDerivePrStateExecutor(deps)` and the `DerivePrStateDependencies` / `DerivePrStateOutput` types. `deps` injects the `GithubReadTransport`, the `Db` (to read the run), and an optional shared `SnapshotCache` and `DeriveContext` — so tests drive the executor without real HTTP.

## Related

- [PR State Derivation](../subsystems/pr-state-derivation.md) — the snapshot fetch + axis derivation this executor wraps.
