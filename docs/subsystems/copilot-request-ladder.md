---
type: Subsystem
title: Copilot Request Ladder
description: Requests the automated reviewer at three precise moments (warmup / approval / merge-time) with refusal-vs-review separation and a bounded merge-time wait.
resource: src/engine/copilot
tags: [lifecycle, copilot, review, resilience]
---

# Copilot Request Ladder

The automated reviewer (Copilot) is requested at three precise moments to collapse the latency between "approved" and "merge-candidate selected". Copilot is **informational, never a hard merge gate** — the merge-time wait is bounded (default ~20 min), and a reviewer **refusal/outage** never spins the daemon or merges un-reviewed code.

These are **pure gating predicates**: each decides _whether_ a request should fire. The caller owns the side effect (the `github_api` request) and the session-dedup store; the predicates only read it. A request the caller fails to place is simply not recorded as sent, so the next pass re-fires it.

## The three events

| Event              | Function                   | Fires when                                                                                                     |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **A — warmup**     | `shouldRequestWarmup`      | A review-bound PR (`Unreviewed` / `AwaitingReReview`) that has never had an **actual** Copilot review.         |
| **A.5 — approval** | `shouldRequestAtApproval`  | The PR became `Approved` and no actual Copilot review **covers HEAD** — request once.                          |
| **B — merge-time** | `shouldRequestAtMergeTime` | The PR is the merge candidate and no actual review covers the current commit — request once, then wait capped. |

All three are session-deduped (`sessionRequested`) and categorically suppressed for **Dependabot PRs** and **interior fix-review cycles** (`isDependabot` / `inInteriorFixReview`). `shouldRequestCopilot(event, input)` dispatches by `CopilotRequestEvent`.

## Refusal vs. review

A Copilot **refusal** ("wasn't able to review") advances activity but is **never** an actual review. The coverage predicates encode this distinction:

- `hasActualCopilotReview(snapshot)` — a non-refusal Copilot review exists.
- `actualCopilotReviewCoversHead(snapshot)` — a non-refusal review covers the **current HEAD** by commit-OID graph position (a review against an older commit does not cover a newer HEAD).
- `isCopilotRefusalOnly(snapshot)` — Copilot's only response is a refusal/outage (review or comment), so a real request still has to fire later.

The shared refusal/actor markers come from the [PR State Derivation](pr-state-derivation.md) module (`isCopilotActor`, `isCopilotRefusal`) so the ladder and the Copilot axis never drift.

## Merge-time bounded wait (Event B)

After the merge-time request fires, `assessCopilotMergeWait(input)` resolves the bounded window three ways:

| Outcome   | When                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------- |
| `Defer`   | An actual review covering HEAD arrived **with open findings** → next route pass addresses them. |
| `Proceed` | Cap exceeded, **or** a refusal/outage (clears the wait), **or** a review with no open findings. |
| `Wait`    | Still within the window and Copilot has neither reviewed nor refused → re-poll.                 |

The caller owns the clock and the re-poll loop; `DEFAULT_COPILOT_WAIT_CAP_MS` is the 20-minute default.

## Related

- [PR State Derivation](pr-state-derivation.md) — the `CopilotState` axis and the shared actor/refusal primitives.
- [Merge Serialization](merge-serialization.md) — the single global merge path Event B feeds into.
