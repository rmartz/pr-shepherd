import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createHostedFirestoreDb,
  type ClientFirestoreModule,
} from "./hostedFirestore";
import { createDb } from "../index";
import { Collections } from "../collections";
import { RunStatus, type Repository, type WorkflowRun } from "../schemas";

// ---------------------------------------------------------------------------
// Unit tests for the hosted Firestore adapter.
//
// The adapter is constructed with injected admin (`firebase-admin/firestore`)
// and client (`firebase/firestore`) handles so the tests can drive it with
// minimal in-memory fakes — no real Firestore, no emulator required.
//
// Integration coverage against the Firebase Emulator lives in
// `hostedFirestore.integration.spec.ts` and skips gracefully when the
// emulator is unreachable.
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

// ---------------------------------------------------------------------------
// Fake `firebase-admin/firestore` — just enough surface for the adapter.
// Stores per-collection docs in a Map; supports get/set/update/delete and
// `where(field, "==", value)` chained queries.
// ---------------------------------------------------------------------------

interface FakeQuerySnapshotDoc {
  id: string;
  data: () => unknown;
}

interface FakeQuerySnapshot {
  docs: FakeQuerySnapshotDoc[];
}

class FakeAdminQuery {
  constructor(
    private readonly store: Map<string, unknown>,
    private readonly filters: { field: string; value: unknown }[] = [],
  ) {}

  where(field: string, op: string, value: unknown): FakeAdminQuery {
    if (op !== "==") throw new Error(`Fake only supports == (got ${op})`);
    return new FakeAdminQuery(this.store, [...this.filters, { field, value }]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(): Promise<FakeQuerySnapshot> {
    const docs: FakeQuerySnapshotDoc[] = [];
    for (const [id, data] of this.store.entries()) {
      const match = this.filters.every(
        (f) => (data as Record<string, unknown>)[f.field] === f.value,
      );
      if (match) docs.push({ id, data: () => data });
    }
    return { docs };
  }
}

class FakeAdminDocRef {
  constructor(
    private readonly store: Map<string, unknown>,
    private readonly id: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(): Promise<{ exists: boolean; data: () => unknown }> {
    const data = this.store.get(this.id);
    return {
      exists: data !== undefined,
      data: () => data,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set(data: unknown): Promise<void> {
    this.store.set(this.id, data);
    triggerListeners(this.store);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async update(patch: Record<string, unknown>): Promise<void> {
    const existing = this.store.get(this.id);
    if (existing === undefined) {
      throw new Error(`No document to update at id ${this.id}`);
    }
    this.store.set(this.id, {
      ...(existing as Record<string, unknown>),
      ...patch,
    });
    triggerListeners(this.store);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(): Promise<void> {
    this.store.delete(this.id);
    triggerListeners(this.store);
  }
}

class FakeAdminCollection extends FakeAdminQuery {
  constructor(store: Map<string, unknown>) {
    super(store);
    (this as unknown as { _store: Map<string, unknown> })._store = store;
  }

  doc(id: string): FakeAdminDocRef {
    return new FakeAdminDocRef(
      (this as unknown as { _store: Map<string, unknown> })._store,
      id,
    );
  }
}

// Listener registry keyed by the per-collection store reference. The fake
// client-SDK `onSnapshot` registers callbacks here; the fake admin-SDK
// mutations trigger them.
const listeners = new Map<
  Map<string, unknown>,
  ((docs: unknown[]) => void)[]
>();

function triggerListeners(store: Map<string, unknown>): void {
  const cbs = listeners.get(store);
  if (!cbs) return;
  const all = Array.from(store.entries()).map(([id, data]) => ({ id, data }));
  for (const cb of [...cbs]) cb(all);
}

function makeFakeAdmin(): {
  store: Map<string, Map<string, unknown>>;
  fakeFirestore: { collection: (name: string) => FakeAdminCollection };
} {
  const store = new Map<string, Map<string, unknown>>();
  function collection(name: string): FakeAdminCollection {
    let s = store.get(name);
    if (s === undefined) {
      s = new Map<string, unknown>();
      store.set(name, s);
    }
    return new FakeAdminCollection(s);
  }
  return { store, fakeFirestore: { collection } };
}

// ---------------------------------------------------------------------------
// Fake `firebase/firestore` client SDK — the adapter only needs `collection`,
// `query`, `where`, and `onSnapshot`. We forward to the admin store so the
// subscribe path observes writes performed via the admin path.
// ---------------------------------------------------------------------------

interface FakeClientQueryHandle {
  store: Map<string, unknown>;
  filters: { field: string; value: unknown }[];
}

interface FakeWhereConstraint {
  field: string;
  value: unknown;
}

function makeFakeClient(
  adminStore: Map<string, Map<string, unknown>>,
): ClientFirestoreModule {
  return {
    collection: (_db, name) => {
      let s = adminStore.get(name);
      if (s === undefined) {
        s = new Map<string, unknown>();
        adminStore.set(name, s);
      }
      const handle: FakeClientQueryHandle = { store: s, filters: [] };
      return handle;
    },
    query: (base, ...constraints) => {
      const baseHandle = base as FakeClientQueryHandle;
      const extra = constraints as FakeWhereConstraint[];
      const merged: FakeClientQueryHandle = {
        store: baseHandle.store,
        filters: [...baseHandle.filters, ...extra],
      };
      return merged;
    },
    where: (field, _op, value) => {
      // The `ClientFirestoreModule` interface narrows `op` to "==" at the
      // type level — no runtime guard needed here.
      const c: FakeWhereConstraint = { field, value };
      return c;
    },
    onSnapshot: (q, cb) => {
      const handle = q as FakeClientQueryHandle;
      function dispatch(): void {
        const all = Array.from(handle.store.entries())
          .filter(([, data]) =>
            handle.filters.every(
              (f) => (data as Record<string, unknown>)[f.field] === f.value,
            ),
          )
          .map(([id, data]) => ({ id, data: () => data }));
        cb({ docs: all });
      }
      // Immediate emit, like real Firestore onSnapshot.
      dispatch();
      // Bridge to the admin-side listener registry so admin writes trigger
      // re-dispatch.
      const wrapped = (): void => {
        dispatch();
      };
      const existing = listeners.get(handle.store) ?? [];
      existing.push(wrapped);
      listeners.set(handle.store, existing);
      return () => {
        const list = listeners.get(handle.store);
        if (!list) return;
        const idx = list.indexOf(wrapped);
        if (idx !== -1) list.splice(idx, 1);
      };
    },
  };
}

beforeEach(() => {
  listeners.clear();
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 1: HostedFirestoreDb implements Db.
// ---------------------------------------------------------------------------
describe("HostedFirestoreDb conforms to the Db interface", () => {
  it("exposes get/list/create/update/delete/subscribe", () => {
    const { fakeFirestore: adminFs } = makeFakeAdmin();
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: makeFakeClient(new Map()),
    });
    expect(typeof db.get).toBe("function");
    expect(typeof db.list).toBe("function");
    expect(typeof db.create).toBe("function");
    expect(typeof db.update).toBe("function");
    expect(typeof db.delete).toBe("function");
    expect(typeof db.subscribe).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 2: writes use firebase-admin.
// ---------------------------------------------------------------------------
describe("Writes go through the injected admin Firestore handle", () => {
  it("create() calls admin .doc(id).set(doc)", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const repo = makeRepo({ id: "a/x", owner: "a" });
    await db.create(Collections.repositories, repo);
    expect(store.get("repositories")?.get(encodeURIComponent("a/x"))).toEqual(
      repo,
    );
  });

  it("update() merges patch into the existing admin doc", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const repo = makeRepo({ concurrencyMax: 2 });
    await db.create(Collections.repositories, repo);
    await db.update(Collections.repositories, repo.id, { concurrencyMax: 7 });
    const stored = store
      .get("repositories")
      ?.get(encodeURIComponent(repo.id)) as Repository;
    expect(stored.concurrencyMax).toBe(7);
    expect(stored.owner).toBe(repo.owner);
  });

  it("delete() removes the doc from the admin collection", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const repo = makeRepo();
    await db.create(Collections.repositories, repo);
    await db.delete(Collections.repositories, repo.id);
    expect(store.get("repositories")?.has(encodeURIComponent(repo.id))).toBe(
      false,
    );
  });

  it("strips undefined fields before persisting", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const run: WorkflowRun = {
      id: "run/1",
      workflowId: "base-pr",
      workflowVersion: 1,
      repo: "rmartz/pr-shepherd",
      prNumber: 50,
      prTitle: "test",
      status: RunStatus.Pending,
      parentRunId: undefined,
      childRunIds: [],
      context: {},
      currentStepId: undefined,
      createdAt: 1,
      updatedAt: 1,
      completedAt: undefined,
      metrics: {
        totalClaudeMs: 0,
        totalActiveMs: 0,
        totalScheduleWaitMs: 0,
        totalExternalWaitMs: 0,
      },
    };
    await db.create(Collections.workflowRuns, run);
    const stored = store
      .get("workflowRuns")
      ?.get(encodeURIComponent(run.id)) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("parentRunId");
    expect(stored).not.toHaveProperty("currentStepId");
    expect(stored).not.toHaveProperty("completedAt");
  });

  it("get() returns the parsed document by id", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    await db.create(Collections.repositories, makeRepo({ id: "g/h" }));
    const got = await db.get(Collections.repositories, "g/h");
    expect(got?.id).toBe("g/h");
  });

  it("get() returns undefined for an unknown id", async () => {
    const { fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(new Map());
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const got = await db.get(Collections.repositories, "nope/none");
    expect(got).toBeUndefined();
  });

  it("list() returns all documents when no filter is supplied", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    await db.create(Collections.repositories, makeRepo({ id: "a/x" }));
    await db.create(Collections.repositories, makeRepo({ id: "b/y" }));
    const all = await db.list(Collections.repositories);
    expect(all).toHaveLength(2);
  });

  it("list() applies a partial-equality filter via admin .where()", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    await db.create(
      Collections.repositories,
      makeRepo({ id: "a/x", owner: "a" }),
    );
    await db.create(
      Collections.repositories,
      makeRepo({ id: "b/y", owner: "b" }),
    );
    const onlyA = await db.list(Collections.repositories, { owner: "a" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.id).toBe("a/x");
  });
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 3: subscribe() wraps onSnapshot, decodes through Zod,
// throws on schema mismatch, and returns an unsubscribe function.
// ---------------------------------------------------------------------------
describe("subscribe() bridges client onSnapshot through Zod", () => {
  it("emits the current snapshot to the callback immediately", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    await db.create(Collections.repositories, makeRepo({ id: "a/x" }));
    const onChange = vi.fn();
    const unsubscribe = db.subscribe(
      Collections.repositories,
      undefined,
      onChange,
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(1);
    unsubscribe();
  });

  it("re-invokes the callback when a new document is created", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const onChange = vi.fn();
    const unsubscribe = db.subscribe(
      Collections.repositories,
      undefined,
      onChange,
    );
    onChange.mockClear();
    await db.create(Collections.repositories, makeRepo({ id: "a/x" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(1);
    unsubscribe();
  });

  it("stops invoking the callback after unsubscribe", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const onChange = vi.fn();
    const unsubscribe = db.subscribe(
      Collections.repositories,
      undefined,
      onChange,
    );
    unsubscribe();
    onChange.mockClear();
    await db.create(Collections.repositories, makeRepo({ id: "a/x" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies a partial-equality filter to subscribe", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const onChange = vi.fn();
    const unsubscribe = db.subscribe(
      Collections.repositories,
      { owner: "a" },
      onChange,
    );
    onChange.mockClear();
    await db.create(
      Collections.repositories,
      makeRepo({ id: "a/x", owner: "a" }),
    );
    await db.create(
      Collections.repositories,
      makeRepo({ id: "b/y", owner: "b" }),
    );
    const lastCall = onChange.mock.calls.at(-1);
    expect(lastCall?.[0]).toHaveLength(1);
    expect(lastCall?.[0][0].owner).toBe("a");
    unsubscribe();
  });

  it("throws when a snapshot document fails Zod validation", () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    // Seed a doc directly into the underlying store that violates the
    // Repository schema (concurrencyMax must be non-negative int).
    const collStore = store.get("repositories") ?? new Map<string, unknown>();
    collStore.set("bad/doc", {
      id: "bad/doc",
      owner: "bad",
      name: "doc",
      enabled: true,
      workflowMap: {},
      concurrencyMax: -5,
      createdAt: 1,
    });
    store.set("repositories", collStore);
    expect(() =>
      db.subscribe(Collections.repositories, undefined, () => {
        // no-op
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 4: all four collections supported via the generic
// CRUD surface keyed by collection name.
// ---------------------------------------------------------------------------
describe("Generic CRUD surface keys storage by collection name", () => {
  it("writes to the collection identified by coll.name", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    await db.create(Collections.repositories, makeRepo({ id: "a/x" }));
    expect(store.has("repositories")).toBe(true);
  });

  it("uses each collection's idField to extract the document id", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    await db.create(Collections.repositories, makeRepo({ id: "owner/repo" }));
    expect(
      store.get("repositories")?.has(encodeURIComponent("owner/repo")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createDb factory wiring.
// ---------------------------------------------------------------------------
describe("createDb factory wires firebase-hosted to the new adapter", () => {
  it("no longer throws the 'not yet implemented' placeholder error", () => {
    // The default `firebase-hosted` path eagerly initializes Firebase Admin
    // (which requires a real private key) and the client SDK. We don't have
    // valid credentials in the test environment, so the call may raise some
    // configuration-related error — but it must NOT raise the old
    // placeholder "not yet implemented" error from before #38.
    let caughtMessage: string | undefined = undefined;
    try {
      createDb({ adapter: "firebase-hosted" });
    } catch (e) {
      caughtMessage = e instanceof Error ? e.message : JSON.stringify(e);
    }
    if (caughtMessage !== undefined) {
      expect(caughtMessage).not.toMatch(/not yet implemented/);
    }
  });
});

// ---------------------------------------------------------------------------
// Capability split: admin SDK is loaded lazily and the client subscribe
// surface refuses collections that firestore.rules does not expose.
// ---------------------------------------------------------------------------
describe("Admin SDK initialization is deferred to first admin method call", () => {
  it("does not touch the admin handle when only subscribe() is called", () => {
    const { store } = makeFakeAdmin();
    const client = makeFakeClient(store);
    // Pass no adminFirestore — if the constructor touched the default loader
    // it would try to `await import("../../lib/firebase/admin")` and
    // initialize firebase-admin, which would fail with no credentials in
    // this environment. The fact that this constructor + subscribe call
    // completes synchronously without error proves the admin path was
    // never hit.
    const db = createHostedFirestoreDb({
      clientFirestoreModule: client,
    });
    const unsubscribe = db.subscribe(
      Collections.repositories,
      undefined,
      () => undefined,
    );
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });
});

describe("subscribe() rejects collections not exposed by firestore.rules", () => {
  it("throws a clear error rather than waiting for a permission-denied snapshot", () => {
    const { store } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      clientFirestoreModule: client,
    });
    // Construct a fake collection definition with a name that's not in the
    // subscribable allowlist; the four real collections (repositories,
    // workflowRuns, stepInstances, workflowDefinitions) are all subscribable
    // per firestore.rules, so we use a synthetic name to test the guard.
    const fakeColl = {
      name: "secrets",
      schema: Collections.repositories.schema,
      idField: "id" as const,
    };
    expect(() => db.subscribe(fakeColl, undefined, () => undefined)).toThrow(
      /not subscribable/,
    );
  });
});
