---
type: Subsystem
title: Self-Observability
description: A per-event audit stream plus a post-run self-analysis that derives merge-efficiency metrics and files issues for recurring anomalies.
resource: src/engine/observability
tags: [observability, audit, anomalies, metrics]
---

# Self-Observability

The self-observability subsystem makes the daemon's own behavior queryable: an append-only audit log of every auditable moment in a run's lifecycle, plus a post-run analysis that mines that log for trouble and files a GitHub issue when it finds it. It is **observation only** — the scheduler never routes off the event stream; the stream records what already happened.

## Event stream

`recordEvent(db, input, now?)` appends one [`EventRecord`](../../src/db/schemas/eventStream.ts) to the `eventStream` collection. The recorder is the single write path: it stamps a fresh id and timestamp so the log stays append-only and uniquely keyed. Each record carries the deciding inputs (PR, HEAD SHA, the gate that decided the action), the [`EventType`](../../src/db/schemas/enums.ts) phase, the producing step, attempt count, an outcome label, and any captured logs. `listRunEvents(db, runId)` reads one run's stream back in chronological order so detectors can reason about sequence.

## Merge-efficiency metrics

`computeMergeMetrics(run, events)` quantifies how much work it took to land one PR: wall-clock, Claude time, external-wait time, review cycles, retries, and whether the merge succeeded on the first try. These are the raw material for spotting inefficient lifecycles at a glance.

## Post-run self-analysis

`analyzeRuns(db, runs, filer, thresholds?)` runs every detector over a cohort of runs, dedupes the findings by `dedupeKey`, and files one issue per distinct anomaly through an injected `IssueFiler` (a seam so the analysis is testable without touching GitHub). The detectors:

| Detector                | Flags                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| timeout-then-fast-retry | a timeout failure whose retry completed suspiciously fast        |
| fix-review loop         | a run that cycled review→fix past a threshold without converging |
| high retry rate         | retries relative to started steps above a ratio                  |
| duration outlier        | wall-clock at a multiple of the cohort median                    |
| merge failure           | any `merge_failed` event                                         |
| mass blocking           | a threshold number of runs paused at once (a systemic stall)     |

Per-run detectors live in [`anomalies/perRun.ts`](../../src/engine/observability/anomalies/perRun.ts); the cross-run mass-blocking detector and the cohort-median helper live in [`anomalies/crossRun.ts`](../../src/engine/observability/anomalies/crossRun.ts). Thresholds default in `DEFAULT_THRESHOLDS` and are fully overridable.

## Related

- [Convergence & Loop Detection](convergence.md) — the in-flight guard against non-converging loops; this subsystem audits them after the fact.
- [Circuit Breakers](circuit-breakers.md) — the queue-halting gates whose effect surfaces as the mass-blocking anomaly.
