import type { Config } from "@/config";
import { Collections } from "@/db/collections";
import type { WebhookEvent } from "@/db/schemas";
import type { Db } from "@/db/types";
import {
  runSelfDiscoveryPass,
  type SelfDiscoveryPassOptions,
  type SelfDiscoveryReport,
} from "@/engine/self-discovery";
import {
  triggerDerivations,
  type TriggerDerivationsDependencies,
} from "@/engine/webhook";
import type { RateLimiter } from "./backpressure";

// ---------------------------------------------------------------------------
// Polling reconciliation fallback (Epic 12, #114).
//
// The event-driven path (#112) re-derives a PR the instant a webhook delivery
// arrives. But correctness must never depend on webhooks alone: a listener can
// miss a delivery, the daemon can be down during a delivery's retry window, or
// GitHub can drop one. `reconcileWebhookEvents` is the low-frequency safety net
// that closes those gaps — the event-receiver analogue of the scheduler's
// reconciliation poll (event-driven-scheduler.md): **latency comes from the
// event path; correctness comes from this poll.**
//
// It does two things each pass, in order:
//
//   1. **Re-trigger derivation for recent deliveries.** Lists persisted
//      `webhookEvents` within a recent window and re-runs `triggerDerivations`
//      for each. Re-deriving is idempotent at the lifecycle level (state is
//      derived, not stored), so an event whose listener-driven trigger landed
//      is at worst re-derived redundantly, while one whose trigger was *missed*
//      is finally caught. This is the reconciliation catch.
//
//   2. **Self-discovery sweep.** Runs `runSelfDiscoveryPass` so a PR that has
//      no tracked run at all — one opened during a daemon outage that no
//      surviving event names — is enrolled. Enrolment stays idempotent
//      (`enrollPr` keys on repo + prNumber + workflowId), so this never double-
//      enrolls a PR already in flight.
//
// **Backpressure.** Step 1 is gated by an injected token-bucket `RateLimiter`:
// each re-trigger consumes one token, and once the bucket empties the pass
// stops re-triggering, deferring the remainder to the next pass. A flood of
// stored events therefore cannot enqueue an unbounded burst of derivations
// that would exhaust the GitHub API budget or starve the daemon — the same
// fail-open deferral the poll itself relies on. Self-discovery (step 2) runs
// regardless, so correctness is never throttled away.
// ---------------------------------------------------------------------------

export interface ReconcileWebhookEventsDependencies {
  db: Db;
  config: Config;
  // Backpressure gate for the re-trigger loop. Each re-trigger consumes one
  // token; when the bucket is empty the pass stops re-triggering.
  rateLimiter: RateLimiter;
  // The self-discovery pass options (transport + workflow resolver). Forwarded
  // verbatim so the reconciliation poll reuses the Epic 11 self-discovery path
  // rather than re-implementing enrolment.
  selfDiscovery: SelfDiscoveryPassOptions;
  // Forwarded to `triggerDerivations` — branch resolver, id factory, clock.
  // `db` is supplied by this module, so it is omitted from the caller's view.
  triggerDeps?: Omit<TriggerDerivationsDependencies, "db">;
  // Only events received at or after `now() - lookbackMs` are re-triggered, so
  // the pass cost stays bounded as the delivery archive grows. Defaults to one
  // hour, comfortably wider than GitHub's delivery-retry window.
  lookbackMs?: number;
  // Injected clock for the lookback window; defaults to `Date.now`.
  now?: () => number;
}

// Why a stored delivery was not re-triggered this pass.
export enum SkipReason {
  // The backpressure bucket was empty — the event is deferred to a later pass.
  RateLimited = "rate_limited",
}

export interface SkippedDelivery {
  deliveryId: string;
  reason: SkipReason;
}

export interface ReconcileWebhookEventsReport {
  // Deliveries whose derivation was re-triggered this pass.
  retriggered: string[];
  // Deliveries left for a later pass because backpressure throttled them.
  skipped: SkippedDelivery[];
  // The self-discovery sweep's result — the correctness net's enrolments.
  discovery: SelfDiscoveryReport;
}

const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000;

// Run one reconciliation pass: re-trigger derivation for recent deliveries
// (throttled by backpressure), then sweep for untracked PRs via self-discovery.
export async function reconcileWebhookEvents(
  deps: ReconcileWebhookEventsDependencies,
): Promise<ReconcileWebhookEventsReport> {
  const now = deps.now ?? Date.now;
  const lookbackMs = deps.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const cutoff = now() - lookbackMs;

  const events = await deps.db.list(Collections.webhookEvents);
  const recent = events
    .filter((event) => event.receivedAt >= cutoff)
    .sort((a, b) => a.receivedAt - b.receivedAt);

  const retriggered: string[] = [];
  const skipped: SkippedDelivery[] = [];

  for (const event of recent) {
    if (!deps.rateLimiter.tryAcquire()) {
      skipped.push({
        deliveryId: event.deliveryId,
        reason: SkipReason.RateLimited,
      });
      continue;
    }
    await retriggerEvent(event, deps);
    retriggered.push(event.deliveryId);
  }

  const discovery = await runSelfDiscoveryPass(
    deps.db,
    deps.config,
    deps.selfDiscovery,
  );

  return { retriggered, skipped, discovery };
}

async function retriggerEvent(
  event: WebhookEvent,
  deps: ReconcileWebhookEventsDependencies,
): Promise<void> {
  await triggerDerivations(event, { db: deps.db, ...deps.triggerDeps });
}
