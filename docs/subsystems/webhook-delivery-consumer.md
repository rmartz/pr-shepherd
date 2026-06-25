---
type: Subsystem
title: Webhook Delivery Consumer
description: Drains the persisted webhook backlog into derivation cycles with delivery dedup, per-PR burst-collapse, and replay/out-of-order tolerance — relying on the idempotent derive→decide core for correctness rather than on delivery order.
resource: src/engine/webhook
tags: [webhook, dedup, coalesce, idempotency, ordering, replay, events]
---

# Webhook Delivery Consumer

The webhook delivery consumer is the third stage of Epic 12's webhook pipeline (Epic 12, [#113](https://github.com/rmartz/pr-shepherd/issues/113); vision [#1](https://github.com/rmartz/pr-shepherd/issues/1) §1, §8.3). The [Webhook Receiver](webhook-receiver.md) (#111) persists each raw delivery to `webhookEvents`; the [Event → Derivation Trigger](event-derivation-trigger.md) (#112) maps one delivery to a re-derivation of the PR(s) it affects. This module is the consumer that sits between them: it **drains the persisted backlog**, driving each unprocessed delivery through the trigger while making GitHub's **at-least-once** and **out-of-order** delivery guarantees harmless.

`consumeWebhookEvents(deps, options)` ([`consume.ts`](../../src/engine/webhook/consume.ts)) lists the `webhookEvents` collection, processes the unprocessed deliveries oldest-first by `receivedAt`, and returns the cycles it enqueued.

## Three tolerances

1. **Delivery dedup.** Each delivery is stamped with `processedAt` ([`webhookEvents` schema](../../src/db/schemas/webhookEvents.ts)) the moment it is consumed. A delivery already carrying `processedAt` — a GitHub redelivery, an operator replay, or a reconciliation re-scan of the same backlog — is skipped. So each unique `X-GitHub-Delivery` drives **at most one** derivation cycle. The receiver already dedupes the _write_ (a second delivery with the same id collides on the document id and is dropped); this consumer dedupes the _processing_ of a delivery that was successfully stored.

2. **Burst-collapse (debounce / coalesce).** A flurry of deliveries that all touch the same PR collapses to a **single** `derive_pr_state` cycle for that PR, not one per event. Coalescing keys on the **resolved run id** of each [target](event-derivation-trigger.md) a delivery implicates — so distinct PRs in the same batch still each get their own cycle, and a delivery that resolves to _several_ PRs (e.g. a `check_suite` referencing PRs 7 and 8) collapses each PR independently. A multi-target delivery never drops its later targets merely because its first target was already collapsed ([#232](https://github.com/rmartz/pr-shepherd/issues/232)). Every delivery in the burst is still marked `processedAt`; only the redundant derivations are suppressed.

3. **Replay / out-of-order tolerance.** Deliveries are processed oldest-first, but **correctness does not depend on order**. The seeded `derive_pr_state` step re-reads PR state from GitHub — _state is derived, not stored_ (vision §1, §8.3) — so the event payload is never trusted as a source of truth. A stale or replayed event therefore **cannot corrupt state**: at worst it triggers a redundant re-derivation, and against a PR whose run has already concluded it is a clean no-op (the trigger finds no active run, so no step is enqueued). This is exactly what the "state is derived, not stored" principle buys.

## Why this is safe

The consumer adds no state of its own beyond the processed-once `processedAt` marker. It is a thin bridge from the receiver's durable store to the idempotent derive→decide core; the same reasoning that makes the [Event → Derivation Trigger](event-derivation-trigger.md) and the [Event-Driven Scheduler](event-driven-scheduler.md) safe applies here — events are a _trigger_, never a source of truth.

## Related

- [Webhook Receiver](webhook-receiver.md) — persists the raw deliveries this consumer drains and dedupes at the write.
- [Event → Derivation Trigger](event-derivation-trigger.md) — the per-delivery mapping this consumer invokes once per coalesced PR.
- [Event-Driven Scheduler](event-driven-scheduler.md) — admits the `derive_pr_state` steps the triggered cycles enqueue.
