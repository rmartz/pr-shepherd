import { describe, it, expect } from "vitest";
import { fetchPrSnapshot, createSnapshotCache } from "../snapshot";
import { TARGET, makeTransport } from "./fixtures";

describe("the cache key incorporates expectedHeadOid so a new commit misses the cache", () => {
  it("keys a call with expectedHeadOid separately from one without it", async () => {
    const transport = makeTransport();
    const cache = createSnapshotCache();
    const now = () => 1000;
    await fetchPrSnapshot(transport, TARGET, { cache, now });
    await fetchPrSnapshot(transport, TARGET, {
      cache,
      now,
      expectedHeadOid: "oid-head",
    });
    // The two calls land on different cache keys, so each triggers its own
    // fetch rather than the second reusing the first's entry.
    expect(transport.graphql).toHaveBeenCalledTimes(2);
    expect([...cache.entries.keys()]).toEqual([
      "rmartz/pr-shepherd#7",
      "rmartz/pr-shepherd#7@oid-head",
    ]);
  });

  it("refetches when expectedHeadOid changes within the TTL instead of serving the stale entry", async () => {
    const transport = makeTransport();
    const cache = createSnapshotCache();
    const now = () => 1000; // a single instant — both calls are well within TTL
    await fetchPrSnapshot(transport, TARGET, {
      cache,
      now,
      expectedHeadOid: "oid-old",
    });
    // A new push advances HEAD; the differing SHA must force a fresh fetch
    // even though the TTL has not elapsed.
    await fetchPrSnapshot(transport, TARGET, {
      cache,
      now,
      expectedHeadOid: "oid-new",
    });
    expect(transport.graphql).toHaveBeenCalledTimes(2);
  });

  it("reuses the cached entry within the TTL when expectedHeadOid is unchanged", async () => {
    const transport = makeTransport();
    const cache = createSnapshotCache();
    const now = () => 1000;
    await fetchPrSnapshot(transport, TARGET, {
      cache,
      now,
      expectedHeadOid: "oid-head",
    });
    await fetchPrSnapshot(transport, TARGET, {
      cache,
      now,
      expectedHeadOid: "oid-head",
    });
    expect(transport.graphql).toHaveBeenCalledTimes(1);
  });
});
