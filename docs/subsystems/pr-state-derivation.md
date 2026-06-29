---
type: Subsystem
title: PR State Derivation
description: Reads a PR's GitHub state once and derives 9 orthogonal state axes — pure and deterministic.
resource: src/engine/derivation
tags: [lifecycle, derivation, gates, github]
---

# PR State Derivation

The derivation subsystem turns a pull request's raw GitHub state into a typed `PrStateVector` the decision layer can act on. It is the **derive** half of the lifecycle's derive → decide → execute loop (see [ARCHITECTURE.md](../../ARCHITECTURE.md)).

## Two stages

1. **Fetch** — `fetchPrSnapshot(transport, target, opts)` performs a rate-limited read (one GraphQL query for metadata/commits/labels/check-suites and the first page of review threads, cursor-paginated GraphQL continuation reads draining any review threads beyond the first 100, plus paginated REST for reviews and issue comments) and returns a raw `PrSnapshot`. Review threads use forward cursor pagination (`first: 100, after:`) rather than `last: 100`, which silently dropped every thread past the cap (#141). `createSnapshotCache()` dedupes concurrent reads of the same PR; `GithubRateLimitError` is retried once. The transport is injected (`GithubReadTransport`) so it is testable without real HTTP. **Transport contract (#140):** because the retry engages only on `GithubRateLimitError`, any `GithubReadTransport` implementation — including the production Octokit/`gh` transport — **must** translate GitHub's HTTP 429 / secondary-rate-limit responses into a thrown `GithubRateLimitError`; any other error type bypasses the backoff and surfaces as a hard failure.
2. **Derive** — `derivePrState(snapshot, context?)` maps that snapshot to a flat `PrStateVector` of nine orthogonal axis enums. It is **pure, deterministic, and side-effect-free** — no GitHub calls, no DB writes — which is what makes the decision layer reproducible.

## The nine axes

`ReviewState`, `CIState`, `MergeConflict`, `CopilotState`, `DependabotRebaseState`, `ThreadState`, `UATState`, `HoldState`, and `Activity` (observational only — never feeds the gate decision). Each is a string enum exported from the module barrel. Inputs that the snapshot cannot supply on its own (e.g. whether a `blocked on #N` issue is still open, or "now") are passed via the data-only `DeriveContext` so the function stays pure.

`DependabotRebaseState` is read from the PR body: `in_progress` when it carries the authoritative-and-current "Dependabot is rebasing this PR" marker (so the daemon must **not** post another `@dependabot rebase`), `failed` for the "Dependabot rebase failed" terminal state, else `none`. It is what the `rebase_dependabot` github_api action's guard consumes.

## Public API

Exported from `src/engine/derivation` (`index.ts`): `fetchPrSnapshot`, `createSnapshotCache`, `GithubRateLimitError`, `derivePrState`, the axis enums, and the `PrSnapshot` / `PrStateVector` / `DeriveContext` types.

## Related

- [claude_skill executor](../steps/claude-skill.md) — the GitHub-mutating side of the loop runs through step executors, not derivation.
