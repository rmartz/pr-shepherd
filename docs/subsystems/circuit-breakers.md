---
type: Subsystem
title: Circuit Breakers
description: Two queue-halting safety gates — CI-budget-exhausted and main-broken — that quarantine work when the environment can't support it.
resource: src/engine/breakers
tags: [resilience, breakers, ci, main-broken]
---

# Circuit Breakers

Two safety gates that halt work when the surrounding environment can't support it, so the daemon doesn't burn budget or pile damage onto a broken base.

## CI-budget-exhausted

When a strict majority of the most recent `main` runs end in `startup_failure`, the runner can't pick up jobs — a billing/quota limit, not a code problem. Dispatching expensive skill work whose CI can never validate it is pointless, so this breaker halts that dispatch queue-wide.

`createCiBudgetBreaker()` returns a latch: `observe(conclusions)` trips it via `isCiBudgetExhausted` (majority `startup_failure`), and once open it **stays open for the process** (a billing limit won't clear mid-run; re-evaluating would flap). `allowsDispatch(prCiAlreadyPassed)` still lets a PR whose HEAD already passed CI proceed — it needs no further CI. Recovery is a fresh daemon start once the cause clears.

## Main-broken

If the most recent `main` push run concluded in `failure`, a post-merge regression broke the base. `assessMainBroken(latest)` reports `{ broken, badSha }`, and `isQuarantined(broken, isFixMainPr)` quarantines **every** PR except the designated `!`-marked fix-main PR allowed to land the repair. It's re-assessed after each in-process merge, so the quarantine lifts the moment a fix turns `main` green again.

Both gates are pure (the budget breaker holds only a latched boolean); the daemon feeds them freshly-observed `main` run state each cycle and consults them before dispatching or merging.

## Related

- [Merge Serialization](merge-serialization.md) — the merge path the main-broken gate quarantines.
- [PR State Derivation](pr-state-derivation.md) — where CI state is derived from GitHub.
