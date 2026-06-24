import { describe, it, expect, vi } from "vitest";
import { createHostedFirestoreDb } from "./hostedFirestore";
import { SubscriptionSource } from "./hostedFirestoreTypes";
import type {
  AdminFirestoreLike,
  AdminQuery,
  AdminQuerySnapshot,
} from "./firestoreAdminTypes";
import { Collections } from "../collections";
import type { Repository } from "../schemas";

// ---------------------------------------------------------------------------
// Seam-level tests for the hosted adapter's admin (daemon) subscription path.
//
// When constructed with `subscriptionSource: Admin`, `subscribe()` must route
// through the admin SDK rather than the client SDK: no firestore.rules gate,
// any collection subscribable, and `closeSubscriptions()` tears every listener
// down. The backoff/lifecycle internals are covered exhaustively in
// `firestoreAdminSubscription.spec.ts`; these are integration smoke tests of
// the wiring. The detailed manager fake is intentionally minimal here.
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

interface FakeColl {
  store: Map<string, unknown>;
  listeners: Set<() => void>;
}

class FakeAdmin implements AdminFirestoreLike {
  private readonly colls = new Map<string, FakeColl>();

  private coll(name: string): FakeColl {
    let c = this.colls.get(name);
    if (c === undefined) {
      c = { store: new Map(), listeners: new Set() };
      this.colls.set(name, c);
    }
    return c;
  }

  collection(name: string): AdminQuery & { doc: never } {
    const c = this.coll(name);
    const snapshot = (): AdminQuerySnapshot => ({
      docs: Array.from(c.store.entries()).map(([id, data]) => ({
        id,
        data: () => data,
      })),
    });
    const query: AdminQuery = {
      where: () => query,
      get: () => Promise.resolve(snapshot()),
      onSnapshot: (onNext) => {
        onNext(snapshot());
        const dispatch = (): void => {
          onNext(snapshot());
        };
        c.listeners.add(dispatch);
        return () => c.listeners.delete(dispatch);
      },
    };
    return query as AdminQuery & { doc: never };
  }

  insert(name: string, id: string, data: unknown): void {
    const c = this.coll(name);
    c.store.set(id, data);
    for (const l of [...c.listeners]) l();
  }

  listenerCount(name: string): number {
    return this.coll(name).listeners.size;
  }
}

describe("hosted adapter admin subscription path", () => {
  it("routes subscribe() through the admin SDK and decodes via Zod", async () => {
    const admin = new FakeAdmin();
    admin.insert(
      Collections.repositories.name,
      "rmartz/pr-shepherd",
      makeRepo(),
    );
    const db = createHostedFirestoreDb({
      adminFirestore: admin,
      subscriptionSource: SubscriptionSource.Admin,
    });
    const onChange = vi.fn();
    db.subscribe(Collections.repositories, undefined, onChange);
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    const docs = onChange.mock.calls[0]?.[0] as Repository[];
    expect(docs[0]?.id).toBe("rmartz/pr-shepherd");
    db.closeSubscriptions();
  });

  it("does not throw for collections the client SDK cannot read", async () => {
    const admin = new FakeAdmin();
    const db = createHostedFirestoreDb({
      adminFirestore: admin,
      subscriptionSource: SubscriptionSource.Admin,
    });
    // `commands` is a daemon-only collection not exposed by firestore.rules;
    // the client path would throw, the admin path must accept it.
    const commandsColl = {
      name: "commands",
      schema: Collections.repositories.schema,
      idField: "id" as const,
    };
    expect(() => db.subscribe(commandsColl, undefined, vi.fn())).not.toThrow();
    await vi.waitFor(() => {
      expect(admin.listenerCount("commands")).toBe(1);
    });
    db.closeSubscriptions();
  });

  it("closeSubscriptions detaches every active admin listener", async () => {
    const admin = new FakeAdmin();
    const db = createHostedFirestoreDb({
      adminFirestore: admin,
      subscriptionSource: SubscriptionSource.Admin,
    });
    db.subscribe(Collections.repositories, undefined, vi.fn());
    db.subscribe(Collections.stepInstances, undefined, vi.fn());
    await vi.waitFor(() => {
      expect(admin.listenerCount(Collections.repositories.name)).toBe(1);
      expect(admin.listenerCount(Collections.stepInstances.name)).toBe(1);
    });
    db.closeSubscriptions();
    expect(admin.listenerCount(Collections.repositories.name)).toBe(0);
    expect(admin.listenerCount(Collections.stepInstances.name)).toBe(0);
  });
});
