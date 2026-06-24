---
type: Subsystem
title: Polling Reconciliation Fallback
description: A low-frequency safety-net poll that re-derives PRs whose webhook deliveries were missed and rate-limits derivation triggered by event storms, so correctness never depends on webhooks alone.
resource: src/engine/reconciliation
tags:
  [reconciliation, webhook, backpressure, rate-limit, fail-open, self-discovery]
---

# Polling Reconciliation Fallback

The [event → derivation trigger](event-derivation-trigger.md) re-derives a PR the instant a webhook delivery arrives — **latency comes from the event path**. But correctness must never depend on webhooks alone: a listener can miss a delivery, the daemon can be down during a delivery's retry window, or GitHub can drop one. `reconcileWebhookEvents` ([`src/engine/reconciliation/webhookReconcile.ts`](../../src/engine/reconciliation/webhookReconcile.ts)) is the low-frequency safety net that closes those gaps (Epic 12, [#114](https://github.com/rmartz/pr-shepherd/issues/114); coordinator spec §8; vision [#1](https://github.com/rmartz/pr-shepherd/issues/1) §13.1). It is the event-receiver analogue of the [event-driven scheduler](event-driven-scheduler.md)'s reconciliation poll: **correctness comes from the poll.**

## What a pass does

Each pass runs two steps in order:

1. **Re-trigger derivation for recent deliveries.** It lists persisted [`webhookEvents`](webhook-receiver.md) within a recent lookback window (default one hour, comfortably wider than GitHub's delivery-retry window) and re-runs `triggerDerivations` for each, oldest-first. Re-deriving is idempotent at the lifecycle level — state is derived, not stored — so a delivery whose listener-driven trigger already landed is at worst re-derived redundantly, while one whose trigger was _missed_ is finally caught. This is the **reconciliation catch**.
2. **Self-discovery sweep.** It runs [`runSelfDiscoveryPass`](self-discovery.md) so a PR with no tracked run at all — one opened during a daemon outage that no surviving event names — is enrolled. Enrolment stays idempotent (`enrollPr` keys on `repo + prNumber + workflowId`), so this never double-enrolls a PR already in flight. The reconciliation poll reuses the Epic 11 self-discovery path rather than re-implementing enrolment.

## Backpressure

A flood of stored events — a force-push across many PRs, a CI matrix completing, a label sweep — must not, unthrottled, enqueue a derivation per event in one burst and exhaust the GitHub API budget the derivations spend or starve the daemon's other work.

Step 1 is gated by an injected token-bucket [`RateLimiter`](../../src/engine/reconciliation/backpressure.ts): each re-trigger consumes one token, and once the bucket empties the pass stops re-triggering, recording the remainder as `rate_limited` and deferring them to the next pass. The bucket starts full (admitting an initial burst up to `capacity`) and refills linearly with elapsed time, so a quiet period restores capacity without a background timer. Because deferral is the same fail-open property the poll itself relies on, the throttled deliveries are not lost — a later pass catches them. **Self-discovery (step 2) runs regardless of the bucket state**, so correctness is never throttled away.

## Secret rotation

Closing the missed-delivery gap is moot if a secret rotation drops live deliveries. [`verifySignature`](../../src/engine/webhook/signature.ts) accepts either a single secret or an array of secrets, and a delivery signed under _any_ accepted secret passes. During a rotation the ingress configures both the new and the previous secret (`[next, current]`); deliveries in flight under the old secret are accepted while GitHub's webhook config is updated, then the old secret is dropped — **zero-downtime rotation**. The match runs against every accepted secret without short-circuiting, so no timing signal distinguishes the new secret from the old.

## Public API

`src/engine/reconciliation` exports `reconcileWebhookEvents` (the pass) with its `ReconcileWebhookEventsReport`, and `createRateLimiter` / `RateLimiter` (the backpressure token bucket).

## Related

- [Event → Derivation Trigger](event-derivation-trigger.md) — the event-path counterpart this poll backstops.
- [Event-Driven Scheduler](event-driven-scheduler.md) — the scheduler's own reconciliation poll, the same fail-open philosophy on the admission side.
- [Self-Discovery](self-discovery.md) — the enrolment path step 2 reuses.
- [Webhook Receiver](webhook-receiver.md) — persists the deliveries this poll re-reads.
