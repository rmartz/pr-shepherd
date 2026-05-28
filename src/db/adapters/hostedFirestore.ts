import * as firestoreClientSdk from "firebase/firestore";
import { getClientFirestore } from "../../lib/firebase/client";
import { Collections } from "../collections";
import type {
  CollectionDef,
  Db,
  Filter,
  SubscriptionCallback,
  Unsubscribe,
} from "../types";

// ---------------------------------------------------------------------------
// Hosted Firestore adapter.
//
// Writes go through `firebase-admin/firestore` (service-account credentials,
// daemon-side). Reactive subscriptions wrap `firebase/firestore`'s
// `onSnapshot` so the Vercel-hosted UI gets push-style updates gated by
// `firestore.rules`.
//
// **Capability split** — admin and client paths are isolated:
//   - The `firebase-admin` SDK is loaded via a **dynamic `await import()`**
//     inside the admin methods. The static import graph of this file does
//     not reach `firebase-admin`, so a UI bundle that only ever calls
//     `subscribe()` will not pull the admin SDK into the browser.
//   - The admin handle is **lazy-initialized** on first admin method call,
//     not in the constructor. Constructing the adapter for UI-only use
//     (subscribe path) does not initialize any admin state.
//   - The `subscribe()` method is purely client-SDK based and is the only
//     method UI consumers need.
//
// Test fakes inject both handles through `HostedFirestoreDbOptions` so the
// real Firebase modules are never touched during unit tests.
// ---------------------------------------------------------------------------

// Minimal structural types — narrow enough that test fakes can implement
// them, broad enough that the real SDKs satisfy them.

interface AdminDocSnapshot {
  exists: boolean;
  data: () => unknown;
}

interface AdminDocRef {
  get: () => Promise<AdminDocSnapshot>;
  set: (data: unknown) => Promise<unknown>;
  update: (patch: Record<string, unknown>) => Promise<unknown>;
  delete: () => Promise<unknown>;
}

interface AdminQuerySnapshot {
  docs: { id: string; data: () => unknown }[];
}

interface AdminQuery {
  where: (field: string, op: "==", value: unknown) => AdminQuery;
  get: () => Promise<AdminQuerySnapshot>;
}

interface AdminCollection extends AdminQuery {
  doc: (id: string) => AdminDocRef;
}

interface AdminFirestoreLike {
  collection: (name: string) => AdminCollection;
}

interface ClientQuerySnapshot {
  docs: { id: string; data: () => unknown }[];
}

export interface ClientFirestoreModule {
  // The Firebase client SDK exposes these as free functions, not methods —
  // mirror that shape.
  collection: (db: unknown, name: string) => unknown;
  query: (base: unknown, ...constraints: unknown[]) => unknown;
  where: (field: string, op: "==", value: unknown) => unknown;
  onSnapshot: (
    q: unknown,
    onNext: (snap: ClientQuerySnapshot) => void,
  ) => () => void;
}

export interface HostedFirestoreDbOptions {
  // Inject for tests. When omitted, the admin SDK is dynamically imported
  // on first admin method call.
  adminFirestore?: AdminFirestoreLike;
  // Inject for tests. Defaults to the statically-imported `firebase/firestore`
  // module bound to the client Firestore handle from
  // `src/lib/firebase/client`.
  clientFirestoreModule?: ClientFirestoreModule;
  // Inject for tests. Defaults to `getClientFirestore()`.
  clientFirestore?: unknown;
}

// Subscribable collection names — UI-readable per `firestore.rules`. The
// adapter throws on `subscribe()` calls for any other collection so an
// out-of-bounds UI subscription fails fast with a clear error rather than
// surfacing as an opaque permission-denied from Firestore.
const SUBSCRIBABLE_COLLECTIONS = new Set<string>([
  Collections.repositories.name,
  Collections.stepInstances.name,
  Collections.workflowDefinitions.name,
  Collections.workflowRuns.name,
]);

// Dynamically load the admin firestore handle. The `await import()` keeps
// `firebase-admin` out of any client bundle that does not reach this code
// path. The resolved module is cached at the call site so repeated admin
// operations do not re-import.
async function loadDefaultAdmin(): Promise<AdminFirestoreLike> {
  const mod = await import("../../lib/firebase/admin");
  return mod.getAdminFirestore() as unknown as AdminFirestoreLike;
}

function loadDefaultClient(): {
  module: ClientFirestoreModule;
  firestore: unknown;
} {
  return {
    module: firestoreClientSdk as unknown as ClientFirestoreModule,
    firestore: getClientFirestore(),
  };
}

function stripUndefinedDeep(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefinedDeep(entry))
      .filter((entry) => entry !== undefined);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripUndefinedDeep(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

export class HostedFirestoreDb implements Db {
  // Admin handle is lazy: either provided at construction (tests) or loaded
  // on first admin call via dynamic import (production). Holding a Promise
  // also serves as a single-flight latch so concurrent admin calls share
  // one load.
  private readonly injectedAdmin: AdminFirestoreLike | undefined;
  private adminPromise: Promise<AdminFirestoreLike> | undefined;

  private readonly clientMod: ClientFirestoreModule;
  private readonly clientFs: unknown;

  constructor(opts: HostedFirestoreDbOptions) {
    this.injectedAdmin = opts.adminFirestore;
    if (opts.clientFirestoreModule !== undefined) {
      this.clientMod = opts.clientFirestoreModule;
      this.clientFs = opts.clientFirestore ?? {};
    } else {
      const loaded = loadDefaultClient();
      this.clientMod = loaded.module;
      this.clientFs = opts.clientFirestore ?? loaded.firestore;
    }
  }

  private getAdmin(): Promise<AdminFirestoreLike> {
    if (this.injectedAdmin !== undefined) {
      return Promise.resolve(this.injectedAdmin);
    }
    this.adminPromise ??= loadDefaultAdmin();
    return this.adminPromise;
  }

  private extractId<T>(coll: CollectionDef<T>, doc: T): string {
    const raw = doc[coll.idField];
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(
        `Document ${coll.name}.${String(coll.idField)} must be a non-empty string; got ${typeof raw === "string" ? `""` : typeof raw}.`,
      );
    }
    return raw;
  }

  private toDocKey(id: string): string {
    return encodeURIComponent(id);
  }

  private filterEntries<T>(
    filter: Filter<T> | undefined,
  ): { field: string; value: unknown }[] {
    if (filter === undefined) return [];
    const out: { field: string; value: unknown }[] = [];
    for (const key of Object.keys(filter) as (keyof T)[]) {
      // Skip undefined filter values (consistent with the in-memory adapter):
      // callers spread optional values and expect undefined to mean
      // "not specified", not "match docs whose field is undefined".
      const value = filter[key];
      if (value === undefined) continue;
      out.push({ field: String(key), value });
    }
    return out;
  }

  async get<T>(coll: CollectionDef<T>, id: string): Promise<T | undefined> {
    const admin = await this.getAdmin();
    const snap = await admin.collection(coll.name).doc(this.toDocKey(id)).get();
    if (!snap.exists) return undefined;
    return coll.schema.parse(snap.data());
  }

  async list<T>(coll: CollectionDef<T>, filter?: Filter<T>): Promise<T[]> {
    const admin = await this.getAdmin();
    let query: AdminQuery = admin.collection(coll.name);
    for (const f of this.filterEntries(filter)) {
      query = query.where(f.field, "==", f.value);
    }
    const snap = await query.get();
    return snap.docs.map((d) => coll.schema.parse(d.data()));
  }

  async create<T>(coll: CollectionDef<T>, doc: T): Promise<void> {
    const parsed = coll.schema.parse(doc);
    const id = this.extractId(coll, parsed);
    const admin = await this.getAdmin();
    await admin
      .collection(coll.name)
      .doc(this.toDocKey(id))
      .set(stripUndefinedDeep(parsed));
  }

  async update<T>(
    coll: CollectionDef<T>,
    id: string,
    patch: Partial<T>,
  ): Promise<void> {
    // Reject id-field changes for the same reason the in-memory adapter
    // does: the document key would diverge from the stored id.
    if (coll.idField in patch) {
      const patchedId = (patch as Partial<Record<keyof T, unknown>>)[
        coll.idField
      ];
      if (patchedId !== undefined && patchedId !== id) {
        throw new Error(
          `Cannot change ${coll.name}.${String(coll.idField)} via update (id "${id}" → "${String(patchedId)}"); delete and re-create instead.`,
        );
      }
    }
    // Fetch-merge-validate-write: Firestore's partial update accepts any
    // shape, but we want the merged document to conform to the schema before
    // persisting. The extra round-trip is acceptable for the daemon's
    // write volume.
    const admin = await this.getAdmin();
    const docRef = admin.collection(coll.name).doc(this.toDocKey(id));
    const snap = await docRef.get();
    if (!snap.exists) {
      throw new Error(`Document ${id} not found in ${coll.name}`);
    }
    const merged = { ...(snap.data() as object), ...patch };
    const parsed = coll.schema.parse(merged);
    await docRef.set(stripUndefinedDeep(parsed));
  }

  async delete<T>(coll: CollectionDef<T>, id: string): Promise<void> {
    const admin = await this.getAdmin();
    await admin.collection(coll.name).doc(this.toDocKey(id)).delete();
  }

  subscribe<T>(
    coll: CollectionDef<T>,
    filter: Filter<T> | undefined,
    onChange: SubscriptionCallback<T>,
  ): Unsubscribe {
    if (!SUBSCRIBABLE_COLLECTIONS.has(coll.name)) {
      throw new Error(
        `Collection "${coll.name}" is not subscribable from the client SDK — firestore.rules denies client reads. Use the admin path (list/get) on the daemon side instead.`,
      );
    }
    const base = this.clientMod.collection(this.clientFs, coll.name);
    const constraints = this.filterEntries(filter).map((f) =>
      this.clientMod.where(f.field, "==", f.value),
    );
    const q =
      constraints.length === 0
        ? base
        : this.clientMod.query(base, ...constraints);
    return this.clientMod.onSnapshot(q, (snap) => {
      // Decode every doc through the Zod schema; a parse failure surfaces
      // to the caller rather than silently returning malformed data.
      onChange(snap.docs.map((d) => coll.schema.parse(d.data())));
    });
  }
}

export function createHostedFirestoreDb(
  opts: HostedFirestoreDbOptions = {},
): Db {
  return new HostedFirestoreDb(opts);
}
