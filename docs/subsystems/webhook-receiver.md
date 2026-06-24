---
type: Subsystem
title: Webhook Receiver
description: GitHub webhook ingress — validates X-Hub-Signature-256, then persists each raw delivery to Firestore keyed by delivery id before any processing.
resource: src/engine/webhook
tags: [webhook, ingress, github, signature, idempotency, persistence]
---

# Webhook Receiver

The webhook receiver is PR Shepherd's **event ingress** (Epic 12, [#111](https://github.com/rmartz/pr-shepherd/issues/111); vision [#1](https://github.com/rmartz/pr-shepherd/issues/1) §13.1, §15). It receives GitHub webhook deliveries, validates each delivery's signature, and persists the raw event to the `webhookEvents` Firestore collection **before any processing** — so deliveries are durable and replay-safe, and downstream state-derivation can be triggered by events rather than polling. Later Epic 12 issues consume those persisted events: the [Event → Derivation Trigger](event-derivation-trigger.md) ([#112](https://github.com/rmartz/pr-shepherd/issues/112)) maps one delivery to a re-derivation, and the [Webhook Delivery Consumer](webhook-delivery-consumer.md) ([#113](https://github.com/rmartz/pr-shepherd/issues/113)) drains the backlog with dedup, burst-collapse, and replay tolerance.

## Pipeline

`receiveWebhook(db, input)` ([`src/engine/webhook/receive.ts`](../../src/engine/webhook/receive.ts)) runs three steps in order and returns a [`WebhookReceiveResult`](../../src/engine/webhook/receive.ts):

1. **Verify signature.** `verifySignature` recomputes the HMAC-SHA256 of the raw request body keyed by the configured secret and compares it in constant time to `X-Hub-Signature-256`. A mismatch, a missing header, or a malformed header returns `Unauthorized` and nothing is persisted (#111 criterion 1).
2. **Check subscription.** The delivery's `X-GitHub-Event` must be one of the subscribed [`WebhookEventType`](../../src/db/schemas/enums.ts) values; anything else returns `Unsubscribed` without persisting.
3. **Persist idempotently.** The raw event is written to `webhookEvents` keyed by `X-GitHub-Delivery`. A second delivery with the same id finds the document already present and returns `Duplicate` rather than overwriting it (#111 criterion 2).

The signature primitive ([`signature.ts`](../../src/engine/webhook/signature.ts)) and the orchestration ([`receive.ts`](../../src/engine/webhook/receive.ts)) are pure and framework-free, so the accept/reject and persistence branches are exhaustively unit-testable without a running server.

## Subscribed event types

The receiver subscribes to these GitHub events (the `webhook.events` setting on the GitHub app/repository webhook must match):

| `X-GitHub-Event`             | Drives                                          |
| ---------------------------- | ----------------------------------------------- |
| `check_run`                  | CI check status                                 |
| `check_suite`                | CI suite status                                 |
| `issue_comment`              | PR conversation comments (skill outcomes, etc.) |
| `pull_request`               | PR open / sync / close / label / review-request |
| `pull_request_review`        | Review submitted / dismissed                    |
| `pull_request_review_thread` | Inline review thread resolve / unresolve        |
| `push`                       | Branch updates (author pushes, merges)          |
| `status`                     | Legacy commit status                            |

## Ingress topology

Per vision §15, the daemon runs locally and **exposes no HTTP port** ([ARCHITECTURE.md](../../ARCHITECTURE.md)), so the HTTP-terminating ingress lives outside the daemon. The receiver logic is topology-agnostic — both options terminate in the same `receiveWebhook` call and write to the same Firestore collection the daemon reads:

- **Vercel-forward (default).** GitHub points at a Next.js App Router route ([`src/app/api/webhook/github/route.ts`](../../src/app/api/webhook/github/route.ts)) in the Vercel UI app. The route reads the raw body and headers, calls `receiveWebhook`, and persists to hosted Firestore via the admin SDK. The local daemon then consumes the events from Firestore.
- **Local tunnel.** GitHub points at a tunnel (e.g. `cloudflared`, `ngrok`) into the operator's machine. With `FIRESTORE_EMULATOR_HOST` set, the same route writes to the emulator the daemon reads — useful for fully-local development.

## Secret handling

The webhook secret is sensitive, so it is read from the environment (`GITHUB_WEBHOOK_SECRET`) at the ingress and passed into `receiveWebhook` — never stored in `config.yaml`, which is reserved for non-secret operator config (see [Deployment Config](../../CLAUDE.md)). A request that arrives before the secret is configured is rejected with `500` rather than processed unsigned.

## Public API

`src/engine/webhook` exports `receiveWebhook` + `WebhookReceiveResult` (the ingress entrypoint and its outcome enum) and `verifySignature` / `computeSignature` (the HMAC primitives).
