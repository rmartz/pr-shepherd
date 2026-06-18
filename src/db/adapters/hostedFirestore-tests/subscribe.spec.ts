import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHostedFirestoreDb } from "../hostedFirestore";
import { Collections } from "../../collections";
import { listeners, makeFakeAdmin, makeFakeClient, makeRepo } from "./fixtures";

beforeEach(() => {
  listeners.clear();
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
