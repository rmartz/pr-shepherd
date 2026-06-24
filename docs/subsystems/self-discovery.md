---
type: Subsystem
title: Self-Discovery
description: Each cycle recomputes the routable PR set from live state and enrolls newly-eligible PRs into runs idempotently.
resource: src/engine/self-discovery
tags: [lifecycle, discovery, enrollment, orchestration, idempotency]
---

# Self-Discovery

Self-discovery is the cross-PR integration that keeps the daemon's work queue honest: the routable PR set is **recomputed from live GitHub state every cycle, not held as a fixed list** (see the [PR-lifecycle design](../design/pr-lifecycle.md) §6 and [ARCHITECTURE.md](../../ARCHITECTURE.md)). `runSelfDiscoveryPass(db, config, options)` is the single daemon-facing seam that ties the merged building blocks into one pass:

```
discover (live sweep) → match author → resolve workflow → enroll run
```

It composes two lower-level modules rather than re-implementing their logic:

- [PR discovery](../../src/engine/discovery) (#125) — `discoverOpenPrs` sweeps every enabled repo's open PRs through the injected `PrReadTransport`, fail-open per repo.
- Run enrollment (#126) — `enrollDiscovered` matches each PR's author to a `workflowId`, resolves it to a loaded graph, and calls `enrollPr` to create a `pending` run + first step.

## Recomputed, not stored

Each pass re-reads open PRs live, so a PR opened **between** passes is picked up on the very next pass with no caller-maintained queue — the transport's current answer _is_ the routable set. This is the orchestration-layer expression of the lifecycle's "state is derived, not stored" principle: the daemon holds no authoritative list of what to work on, only a way to recompute it.

## No double-enrolment

Idempotency lives one layer down in `enrollPr`, keyed on `repo + prNumber + workflowId` and skipping non-terminal runs. An already-enrolled / in-flight PR re-discovered on a later pass therefore yields `created: false` and **no second run**. Self-discovery adds no state of its own that could drift from that guard — re-running a pass is always safe.

The dedupe lookup (`findActiveRun`) queries `workflowRuns` on those three equality fields and then narrows by run status. A composite index `(repo, prNumber, workflowId, status)` on the `workflowRuns` collection backs that query — declared in [`firestore.indexes.json`](../../firestore.indexes.json) so it stays index-backed as run volume grows (#167).

## Observability: phases and exclusions

The daemon runs discovery at three points in each drain (lifecycle design §6): **upfront**, **opportunistically mid-batch** when a worker slot frees, and at **end of drain**. `DiscoveryPhase` tags which trigger fired a given pass — purely an observability label, since the discover→enroll logic is identical at each point. Every pass logs its exclusion reasons, each tagged with the phase:

- per-PR enrollment skips with their `SkipReason` (`unknown_repo` / `no_match` / `unresolved_workflow`), and
- tolerated per-repo discovery errors (surfaced in `report.discoveryErrors` so a rate-limit failure does not masquerade as "no PRs found").

The returned `SelfDiscoveryReport` carries the `enrolled` / `skipped` lists from enrollment plus the `phase` and `discoveryErrors`, so a caller (e.g. a circuit breaker) can react without parsing logs.
