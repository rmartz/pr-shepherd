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
