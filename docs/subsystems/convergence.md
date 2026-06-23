---
type: Subsystem
title: Convergence & Loop Detection
description: Catch non-converging fix→review loops without a hard round cap — a same-action-spin detector plus a flapper-escalating reflection cadence.
resource: src/engine/convergence
tags: [lifecycle, resilience, loop-detection, convergence]
---

# Convergence & Loop Detection

A fix→review cycle that never converges must be caught — but **not** with a hard round cap, which would wrongly punish a genuinely large PR that is still making progress. Two complementary mechanisms:

## Same-action loop detection

`detectSameActionLoop(ticks)` looks at the trailing run of identical `(action, stateFingerprint)` ticks. When an action runs and the PR routes straight back to the **same action with no intervening state change** (a review that posted no verdict, a fix that resolved nothing), the fingerprints match and the run grows; once it reaches `maxConsecutive` (default 3 — **one transient retry allowed**), the verdict is `Spinning`. A real state change produces a different fingerprint, breaking the run → `Progressing`. Pure, structural — no time or round counting.

## Convergence reflection

For slower flapping that isn't a literal same-action spin, a periodic `assess-progress` reflection (an LLM skill) judges **converging vs flapping**. The engine owns the _cadence_ and the _response_, not the judgment:

- `durableReviewCount(outcomes)` counts `review` skill-outcome markers (#151) on the PR — a **durable** count read from GitHub, so the cadence survives daemon restarts/timeouts (never in-memory).
- `shouldAssessProgress(reviewCount)` fires the reflection every Nth review (default 3), never at zero.
- `resolveConvergence(verdict)` maps the reflection's verdict to an action: **escalate only flappers** (`escalation needed`); a converging loop continues.

## Related

- [Skill Outcome Protocol](skill-outcome-protocol.md) — supplies the durable review markers the cadence counts.
- [Gate Model](gate-model.md) — the `Action` each tick records for spin detection.
