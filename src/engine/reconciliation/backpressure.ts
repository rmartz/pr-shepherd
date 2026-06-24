// ---------------------------------------------------------------------------
// Backpressure for event-driven derivation (Epic 12, #114).
//
// The webhook receiver persists every delivery, and each delivery can fan out
// to one or more `derive_pr_state` triggers. A storm of events — a force-push
// across many PRs, a CI matrix completing, a label sweep — would, unthrottled,
// enqueue a derivation per event in a tight burst and exhaust the GitHub API
// budget the derivations spend, or starve the daemon's other work. (Vision
// §13.1; coordinator spec §8 safety gates.)
//
// `createRateLimiter` is a pure token-bucket: a bounded pool of tokens that
// refills linearly over time. The reconciliation pass calls `tryAcquire()`
// before each derivation trigger and stops triggering for the current pass
// once the bucket is empty — the un-triggered events are not lost, they are
// simply caught by a later pass (the same fail-open property the reconciliation
// poll relies on). Time is injected (`now`) so the refill is testable without
// wall-clock waits, mirroring the clock seams used elsewhere in the engine.
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  // Maximum tokens the bucket holds — the largest burst admitted before
  // throttling kicks in.
  capacity: number;
  // Tokens replenished per `refillIntervalMs`. Combined with the interval this
  // sets the sustained rate (e.g. `refillTokens: 5`, `refillIntervalMs: 1000`
  // ⇒ 5 derivations/second once the initial burst is spent).
  refillTokens: number;
  // The window over which `refillTokens` are added back, in milliseconds.
  refillIntervalMs: number;
  // Injected clock; defaults to `Date.now`. Tests advance a fake clock to drive
  // the refill deterministically.
  now?: () => number;
}

export interface RateLimiter {
  // Consume one token if any are available, returning whether the caller may
  // proceed. Refills lazily from elapsed time on each call, so a quiet period
  // restores capacity without a background timer.
  tryAcquire: () => boolean;
  // Tokens currently available (after a lazy refill). Exposed for observability
  // and assertions; callers gate on `tryAcquire`, not on this.
  available: () => number;
}

// A token bucket whose tokens refill linearly with elapsed time. The bucket
// starts full so the first burst up to `capacity` is admitted immediately.
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const ratePerMs = options.refillTokens / options.refillIntervalMs;

  let tokens = options.capacity;
  let lastRefillAt = now();

  const refill = (): void => {
    const at = now();
    const elapsed = at - lastRefillAt;
    if (elapsed <= 0) return;
    tokens = Math.min(options.capacity, tokens + elapsed * ratePerMs);
    lastRefillAt = at;
  };

  return {
    tryAcquire: () => {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    available: () => {
      refill();
      return Math.floor(tokens);
    },
  };
}
