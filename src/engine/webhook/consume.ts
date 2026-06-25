import { Collections } from "@/db/collections";
import {
  triggerDerivations,
  type DerivationTrigger,
  type TriggerDerivationsDependencies,
} from "./derivation-trigger";

// ---------------------------------------------------------------------------
// Webhook delivery consumer (Epic 12, #113).
//
// GitHub delivers webhooks **at-least-once** and **out-of-order**. The #112
// trigger maps a single persisted delivery to a derivation cycle; this module
// is the consumer that drains the persisted `webhookEvents` backlog and drives
// each delivery into that trigger while making the at-least-once / out-of-order
// guarantees harmless:
//
//   1. **Dedup** — every delivery is stamped with `processedAt` the moment it
//      is consumed. A delivery already carrying `processedAt` (a redelivery, a
//      replay, or a reconciliation re-scan of the same backlog) is skipped, so
//      each unique `X-GitHub-Delivery` drives at most one derivation cycle.
//   2. **Burst-collapse** — a flurry of deliveries that all touch the same PR
//      collapses to a *single* `derive_pr_state` cycle per PR, not one per
//      event. Coalescing keys on each delivery's resolved run id, so distinct
//      PRs still each get their own cycle — and a delivery resolving to several
//      PRs collapses each independently, never dropping its later targets just
//      because its first was already collapsed.
//   3. **Replay / out-of-order tolerance** — deliveries are processed
//      oldest-first by `receivedAt`, but correctness does **not** depend on
//      order: the seeded `derive_pr_state` step re-reads PR state from GitHub
//      (state is derived, not stored — vision §1, §8.3). A stale or replayed
//      event therefore cannot corrupt state; at worst it triggers a redundant
//      re-derivation, and against a PR whose run has concluded it is a clean
//      no-op (the trigger finds no active run).
//
// The consumer is the bridge between the receiver's durable store and the
// idempotent derive→decide core; it adds no state of its own beyond the
// processed-once marker.
// ---------------------------------------------------------------------------

export interface ConsumeWebhookEventsOptions {
  // Injected clock for the `processedAt` stamp. Defaults to the host clock;
  // tests supply a deterministic value.
  now?: () => number;
}

export interface ConsumeWebhookEventsResult {
  // Number of previously-unprocessed deliveries drained this pass (each now
  // carries `processedAt`), including those that resolved to no active run.
  consumed: number;
  // The derivation cycles enqueued — one per distinct PR the consumed batch
  // touched, after burst-collapse. Empty when nothing was tracked.
  triggered: DerivationTrigger[];
}

// Drain the unprocessed `webhookEvents` backlog into derivation cycles.
export async function consumeWebhookEvents(
  deps: TriggerDerivationsDependencies,
  options: ConsumeWebhookEventsOptions = {},
): Promise<ConsumeWebhookEventsResult> {
  const now = options.now ?? Date.now;
  const all = await deps.db.list(Collections.webhookEvents);
  const pending = all
    .filter((event) => event.processedAt === undefined)
    .sort((a, b) => a.receivedAt - b.receivedAt);

  const triggered: DerivationTrigger[] = [];
  // Shared across the batch, keyed on resolved run id: a run already triggered
  // this pass is skipped, collapsing the burst. Threading it through
  // `triggerDerivations` (rather than keying on each delivery's first target)
  // coalesces **per target**, so a multi-target delivery still triggers its
  // later targets even when its first target was already collapsed (#232).
  const seen = new Set<string>();
  const processedAt = now();
  for (const event of pending) {
    const result = await triggerDerivations(event, deps, seen);
    triggered.push(...result.triggered);
    await deps.db.update(Collections.webhookEvents, event.id, { processedAt });
  }

  return { consumed: pending.length, triggered };
}
