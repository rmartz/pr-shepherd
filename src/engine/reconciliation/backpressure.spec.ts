import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./backpressure";

// ---------------------------------------------------------------------------
// Token-bucket backpressure (#114 acceptance criterion 2). The limiter caps
// how many derivations a reconciliation pass triggers in a burst and refills
// linearly over time. A fake clock drives the refill deterministically.
// ---------------------------------------------------------------------------

function fakeClock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("admits an initial burst up to capacity", () => {
  it("grants exactly `capacity` tokens before throttling", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      capacity: 3,
      refillTokens: 1,
      refillIntervalMs: 1000,
      now: clock.now,
    });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    // Fourth acquire in the same instant exceeds the burst and is denied.
    expect(limiter.tryAcquire()).toBe(false);
  });
});

describe("refills linearly as time elapses", () => {
  it("grants one more token after one refill interval", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      capacity: 2,
      refillTokens: 1,
      refillIntervalMs: 1000,
      now: clock.now,
    });

    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBe(false);

    clock.advance(1000);
    expect(limiter.tryAcquire()).toBe(true);
    // Only one token refilled, so the next acquire is throttled again.
    expect(limiter.tryAcquire()).toBe(false);
  });
});

describe("does not refill beyond capacity", () => {
  it("caps available tokens at `capacity` after a long idle period", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      capacity: 2,
      refillTokens: 5,
      refillIntervalMs: 1000,
      now: clock.now,
    });

    limiter.tryAcquire();
    limiter.tryAcquire();
    // Idle far longer than needed to refill the whole bucket many times over.
    clock.advance(10_000);

    expect(limiter.available()).toBe(2);
  });
});
