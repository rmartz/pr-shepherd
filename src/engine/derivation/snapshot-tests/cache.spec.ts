import { describe, it, expect } from "vitest";
import { fetchPrSnapshot, createSnapshotCache } from "../snapshot";
import { TARGET, makeTransport } from "./fixtures";

describe("concurrent reads of the same PR dedupe to a single fetch", () => {
  it("shares one in-flight fetch when a cache is provided", async () => {
    const transport = makeTransport();
    const cache = createSnapshotCache();
    const [a, b] = await Promise.all([
      fetchPrSnapshot(transport, TARGET, { cache }),
      fetchPrSnapshot(transport, TARGET, { cache }),
    ]);
    expect(transport.graphql).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
});

describe("a cached snapshot is reused within the TTL and refetched after it expires", () => {
  it("refetches only once the TTL has elapsed", async () => {
    const transport = makeTransport();
    const cache = createSnapshotCache();
    let clock = 1000;
    const now = () => clock;
    await fetchPrSnapshot(transport, TARGET, { cache, now, ttlMs: 120_000 });
    clock = 1000 + 119_000; // within TTL
    await fetchPrSnapshot(transport, TARGET, { cache, now, ttlMs: 120_000 });
    expect(transport.graphql).toHaveBeenCalledTimes(1);
    clock = 1000 + 121_000; // past TTL
    await fetchPrSnapshot(transport, TARGET, { cache, now, ttlMs: 120_000 });
    expect(transport.graphql).toHaveBeenCalledTimes(2);
  });
});

describe("expired entries are proactively evicted on write, not just on read (#128)", () => {
  const OTHER = { owner: "rmartz", repo: "pr-shepherd", prNumber: 42 };

  it("drops an expired entry for one PR when a different PR is written", async () => {
    const transport = makeTransport();
    const cache = createSnapshotCache();
    let clock = 1000;
    const now = () => clock;

    await fetchPrSnapshot(transport, TARGET, { cache, now, ttlMs: 120_000 });
    expect(cache.entries.size).toBe(1);

    clock = 1000 + 121_000; // TARGET's entry is now past its TTL
    await fetchPrSnapshot(transport, OTHER, { cache, now, ttlMs: 120_000 });

    expect(cache.entries.size).toBe(1);
    expect(cache.entries.has("rmartz/pr-shepherd#42")).toBe(true);
    expect(cache.entries.has("rmartz/pr-shepherd#7")).toBe(false);
  });

  it("retains an unexpired entry for one PR when a different PR is written", async () => {
    const transport = makeTransport();
    const cache = createSnapshotCache();
    let clock = 1000;
    const now = () => clock;

    await fetchPrSnapshot(transport, TARGET, { cache, now, ttlMs: 120_000 });
    clock = 1000 + 60_000; // TARGET's entry is still within its TTL
    await fetchPrSnapshot(transport, OTHER, { cache, now, ttlMs: 120_000 });

    expect(cache.entries.size).toBe(2);
    expect(cache.entries.has("rmartz/pr-shepherd#7")).toBe(true);
    expect(cache.entries.has("rmartz/pr-shepherd#42")).toBe(true);
  });
});
