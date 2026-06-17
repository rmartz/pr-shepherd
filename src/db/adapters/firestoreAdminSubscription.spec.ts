import { describe, it, expect, vi } from "vitest";
import { AdminSubscriptionManager } from "./firestoreAdminSubscription";
import type {
  AdminFirestoreLike,
  AdminQuery,
  AdminQuerySnapshot,
} from "./firestoreAdminTypes";
import { Collections } from "../collections";
import type { Repository } from "../schemas";

// ---------------------------------------------------------------------------
// Unit tests for the daemon-side (admin SDK) subscription manager.
//
// A fake admin Firestore drives the manager without real Firestore. Each
// collection is a Map; `onSnapshot` registers a dispatcher that re-emits on
// mutation, and an injectable error hook lets tests force the transient-error
// backoff path. Timers are injected so backoff is deterministic.
// ---------------------------------------------------------------------------

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "rmartz/pr-shepherd",
    owner: "rmartz",
    name: "pr-shepherd",
    enabled: true,
    workflowMap: { "*": "base-pr" },
    concurrencyMax: 2,
    createdAt: 1716700000000,
    ...overrides,
  };
}

interface FakeCollection {
  store: Map<string, unknown>;
  listeners: Set<() => void>;
  // Set to a non-undefined error to make the next onSnapshot attach fail by
  // invoking its onError. Cleared after firing so a re-subscribe can succeed.
  nextError: Error | undefined;
}

class FakeAdmin implements AdminFirestoreLike {
  readonly collections = new Map<string, FakeCollection>();

  private coll(name: string): FakeCollection {
    let c = this.collections.get(name);
    if (c === undefined) {
      c = { store: new Map(), listeners: new Set(), nextError: undefined };
      this.collections.set(name, c);
    }
    return c;
  }

  collection(name: string): AdminQuery & { doc: never } {
    return this.buildQuery(this.coll(name), []) as AdminQuery & { doc: never };
  }

  // Insert a doc and notify every live listener on that collection.
  insert(name: string, id: string, data: unknown): void {
    const c = this.coll(name);
    c.store.set(id, data);
    for (const l of [...c.listeners]) l();
  }

  // Force the next onSnapshot on `name` to fail via its onError callback.
  failNext(name: string): void {
    this.coll(name).nextError = new Error("transient stream drop");
  }

  listenerCount(name: string): number {
    return this.coll(name).listeners.size;
  }

  private buildQuery(
    c: FakeCollection,
    filters: { field: string; value: unknown }[],
  ): AdminQuery {
    const snapshot = (): AdminQuerySnapshot => ({
      docs: Array.from(c.store.entries())
        .filter(([, data]) =>
          filters.every(
            (f) => (data as Record<string, unknown>)[f.field] === f.value,
          ),
        )
        .map(([id, data]) => ({ id, data: () => data })),
    });
    return {
      where: (field, _op, value) =>
        this.buildQuery(c, [...filters, { field, value }]),
      get: () => Promise.resolve(snapshot()),
      onSnapshot: (onNext, onError) => {
        if (c.nextError !== undefined) {
          const err = c.nextError;
          c.nextError = undefined;
          onError(err);
          return () => undefined;
        }
        onNext(snapshot());
        const dispatch = (): void => {
          onNext(snapshot());
        };
        c.listeners.add(dispatch);
        return () => c.listeners.delete(dispatch);
      },
    };
  }
}

function makeManager(
  admin: FakeAdmin,
  overrides: Partial<{
    baseBackoffMs: number;
    maxBackoffMs: number;
    setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer: (h: ReturnType<typeof setTimeout>) => void;
  }> = {},
): AdminSubscriptionManager {
  return new AdminSubscriptionManager({
    loadAdmin: () => Promise.resolve(admin),
    ...overrides,
  });
}

describe("admin subscribe() fans out snapshots through the admin SDK", () => {
  it("emits the current snapshot to the callback after attach", async () => {
    const admin = new FakeAdmin();
    admin.insert(
      Collections.repositories.name,
      "rmartz/pr-shepherd",
      makeRepo(),
    );
    const onChange = vi.fn();
    const mgr = makeManager(admin);
    mgr.subscribe(Collections.repositories, undefined, onChange);
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(1);
    mgr.closeAll();
  });

  it("re-invokes the callback when a new document lands", async () => {
    const admin = new FakeAdmin();
    const onChange = vi.fn();
    const mgr = makeManager(admin);
    mgr.subscribe(Collections.repositories, undefined, onChange);
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    onChange.mockClear();
    admin.insert(Collections.repositories.name, "a/x", makeRepo({ id: "a/x" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(1);
    mgr.closeAll();
  });

  it("applies a partial-equality filter to the admin query", async () => {
    const admin = new FakeAdmin();
    admin.insert(
      Collections.repositories.name,
      "a/x",
      makeRepo({ id: "a/x", owner: "a" }),
    );
    admin.insert(
      Collections.repositories.name,
      "b/y",
      makeRepo({ id: "b/y", owner: "b" }),
    );
    const onChange = vi.fn();
    const mgr = makeManager(admin);
    mgr.subscribe(Collections.repositories, { owner: "a" }, onChange);
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    const docs = onChange.mock.calls[0]?.[0] as Repository[];
    expect(docs).toHaveLength(1);
    expect(docs[0]?.owner).toBe("a");
    mgr.closeAll();
  });
});

describe("admin subscription lifecycle teardown", () => {
  it("unsubscribe detaches the listener so later writes are ignored", async () => {
    const admin = new FakeAdmin();
    const onChange = vi.fn();
    const mgr = makeManager(admin);
    const unsubscribe = mgr.subscribe(
      Collections.repositories,
      undefined,
      onChange,
    );
    await vi.waitFor(() => {
      expect(admin.listenerCount(Collections.repositories.name)).toBe(1);
    });
    unsubscribe();
    expect(admin.listenerCount(Collections.repositories.name)).toBe(0);
    onChange.mockClear();
    admin.insert(Collections.repositories.name, "a/x", makeRepo({ id: "a/x" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closeAll detaches every active listener for graceful shutdown", async () => {
    const admin = new FakeAdmin();
    const mgr = makeManager(admin);
    mgr.subscribe(Collections.repositories, undefined, vi.fn());
    mgr.subscribe(Collections.stepInstances, undefined, vi.fn());
    await vi.waitFor(() => {
      expect(admin.listenerCount(Collections.repositories.name)).toBe(1);
      expect(admin.listenerCount(Collections.stepInstances.name)).toBe(1);
    });
    mgr.closeAll();
    expect(admin.listenerCount(Collections.repositories.name)).toBe(0);
    expect(admin.listenerCount(Collections.stepInstances.name)).toBe(0);
  });
});

describe("admin subscription recovers from transient stream errors", () => {
  it("re-subscribes with backoff after onError and resumes fan-out", async () => {
    const admin = new FakeAdmin();
    const timers: (() => void)[] = [];
    const mgr = makeManager(admin, {
      baseBackoffMs: 10,
      setTimer: (cb) => {
        timers.push(cb);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    admin.failNext(Collections.repositories.name);
    const onChange = vi.fn();
    mgr.subscribe(Collections.repositories, undefined, onChange);
    // First attach hit the forced error: no snapshot delivered, a retry timer
    // was scheduled instead.
    await vi.waitFor(() => {
      expect(timers).toHaveLength(1);
    });
    expect(onChange).not.toHaveBeenCalled();
    // Fire the backoff timer — the second attach succeeds and delivers a
    // snapshot, proving the dropped stream recovered.
    timers[0]?.();
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(admin.listenerCount(Collections.repositories.name)).toBe(1);
    mgr.closeAll();
  });

  it("does not re-subscribe after unsubscribe cancels a pending retry", async () => {
    const admin = new FakeAdmin();
    const timers: (() => void)[] = [];
    let cleared = 0;
    const mgr = makeManager(admin, {
      baseBackoffMs: 10,
      setTimer: (cb) => {
        timers.push(cb);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        cleared += 1;
      },
    });
    admin.failNext(Collections.repositories.name);
    const onChange = vi.fn();
    const unsubscribe = mgr.subscribe(
      Collections.repositories,
      undefined,
      onChange,
    );
    await vi.waitFor(() => {
      expect(timers).toHaveLength(1);
    });
    unsubscribe();
    expect(cleared).toBe(1);
    // Even if a stale timer fires, the cancelled subscription must not attach.
    timers[0]?.();
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    expect(admin.listenerCount(Collections.repositories.name)).toBe(0);
  });
});
