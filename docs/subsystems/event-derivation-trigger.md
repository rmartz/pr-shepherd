---
type: Subsystem
title: Event → Derivation Trigger
description: Maps each persisted webhook delivery to the PR(s) it affects and re-seeds those tracked runs at the derive_pr_state lifecycle head — a poll→event trigger swap with no lifecycle change.
resource: src/engine/webhook
tags: [webhook, trigger, derivation, lifecycle, events, idempotency]
---

# Event → Derivation Trigger

The event → derivation trigger is the second half of Epic 12's webhook pipeline (Epic 12, [#112](https://github.com/rmartz/pr-shepherd/issues/112); vision [#1](https://github.com/rmartz/pr-shepherd/issues/1) §4.1, §13.1). The [Webhook Receiver](webhook-receiver.md) (#111) persists each raw GitHub delivery to `webhookEvents`; this module consumes one persisted event, works out which PR(s) it affects, and **re-seeds each affected tracked run at the head of its lifecycle loop** so the next scheduler tick re-derives state. It is the event-sourced replacement for the discovery poll as the _trigger_ — **the lifecycle core ([PR State Derivation](pr-state-derivation.md) → [Gate Model](gate-model.md)) is reused unchanged**.

## Two stages

`triggerDerivations(event, deps)` ([`derivation-trigger.ts`](../../src/engine/webhook/derivation-trigger.ts)) composes a pure mapping with a Db effect:

1. **Map event → targets** — `eventToTargets(event)` ([`event-target.ts`](../../src/engine/webhook/event-target.ts)) is a pure function over the stored payload (no I/O). Each subscribed [`WebhookEventType`](../../src/db/schemas/enums.ts) names its PR in a different place, so the mapper is exhaustive over the enum:

   | Event                                                               | PR named by                                                            |
   | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
   | `pull_request`, `pull_request_review`, `pull_request_review_thread` | `pull_request.number` (or top-level `number`)                          |
   | `check_run`, `check_suite`, `status`                                | `pull_requests[].number` (one commit can span several PRs)             |
   | `issue_comment`                                                     | `issue.number` — only when `issue.pull_request` is present             |
   | `push`                                                              | the updated branch in `ref` (a **branch target**, resolved in stage 2) |

   An event whose payload names no PR (a plain-issue comment, a tag push, a branch delete, a malformed body) yields `[]`.

2. **Resolve & enqueue** — each PR-number target is looked up against tracked runs by `repo + prNumber`; each `push` branch target is first expanded to PR number(s) via the injected `resolveBranch` seam (runs key on PR number, not branch, so branch→PR resolution is supplied by the caller / discovery transport). For every **active** run found (`pending` or `running`), a fresh `pending` `derive_pr_state` [`stepInstance`](../../src/db/schemas/stepInstances.ts) is created. That step is the head of the [base-pr](../../workflows/base-pr.yaml) loop — `derive_pr_state → evaluate_gates → …` — so the scheduler picks it up and the gate model selects the next action from freshly-derived state.

## Trigger swap only — no lifecycle change

The enqueued cycle reuses the existing run/step path verbatim: it creates a `derive_pr_state` step and **does not mutate the run** itself. Only the _source_ of the trigger changes from poll to event. This is safe for the same reason the [event-driven scheduler](event-driven-scheduler.md) is safe — _state is derived, not stored_, so re-deriving is idempotent. A duplicated, out-of-order, or replayed event at worst causes a redundant derivation, never a corrupt transition. Enrolment of _new_ PRs stays the discovery loop's job ([Self-Discovery](self-discovery.md)); this trigger only re-derives PRs that already have a run.

## Clean drops

`TriggerDerivationsResult.dropped` records why an event produced no trigger, so the ingress can log a no-op rather than silently swallow it:

- `no_target` — the payload named no PR at all.
- `untracked` — the named PR(s) have no active run (none tracked, or the only run is terminal).

## Related

- [Webhook Receiver](webhook-receiver.md) — persists the raw deliveries this module consumes.
- [Event-Driven Scheduler](event-driven-scheduler.md) — admits the `derive_pr_state` step this trigger enqueues; a webhook-derived trigger is one of its subscription sources.
- [PR State Derivation](pr-state-derivation.md) / [Gate Model](gate-model.md) — the reused lifecycle core the re-seeded step drives.
