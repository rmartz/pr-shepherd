import { describe, it, expect, beforeEach } from "vitest";
import { createHostedFirestoreDb } from "../hostedFirestore";
import { createDb, DbAdapterKind } from "../../index";
import { Collections } from "../../collections";
import { makeRepo } from "./fixtures";
import { listeners, makeFakeAdmin, makeFakeClient } from "./fakeAdminQuery";

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
      createDb({ adapter: DbAdapterKind.FirebaseHosted });
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
