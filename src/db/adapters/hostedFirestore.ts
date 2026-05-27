import * as firestoreClientSdk from "firebase/firestore";
import { getAdminFirestore } from "../../lib/firebase/admin";
import { getClientFirestore } from "../../lib/firebase/client";
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
// The adapter is structured so the admin and client handles can be injected
// for unit tests; in production, default initializers resolve to
// `getAdminFirestore()` (daemon) and `getClientFirestore()` (UI). See
// `src/lib/firebase/*` for the underlying SDK setup.
// ---------------------------------------------------------------------------

// Minimal structural types — narrow enough that test fakes can implement
// them, broad enough that the real SDKs satisfy them. We deliberately avoid
// importing the SDK types here so the adapter file itself does not pull in
// firebase-admin at module-eval time (the lazy default loaders handle that).

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
  // Inject for tests. Defaults to `getAdminFirestore()` from
  // `src/lib/firebase/admin`.
  adminFirestore?: AdminFirestoreLike;
  // Inject for tests. Defaults to the lazily-imported `firebase/firestore`
  // module bound to the client Firestore handle from
  // `src/lib/firebase/client`.
  clientFirestoreModule?: ClientFirestoreModule;
  // Inject for tests. Defaults to `getClientFirestore()`.
  clientFirestore?: unknown;
}

// Default loaders. Functions, not module-eval-time calls, so importing the
// module does not initialize Firebase — only constructing the adapter does
// (and even then only when the caller did not inject handles).
function loadDefaultAdmin(): AdminFirestoreLike {
  return getAdminFirestore() as unknown as AdminFirestoreLike;
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

class HostedFirestoreDb implements Db {
  private readonly admin: AdminFirestoreLike;
  private readonly clientMod: ClientFirestoreModule;
  private readonly clientFs: unknown;

  constructor(opts: HostedFirestoreDbOptions) {
    this.admin = opts.adminFirestore ?? loadDefaultAdmin();
    if (opts.clientFirestoreModule !== undefined) {
      this.clientMod = opts.clientFirestoreModule;
      this.clientFs = opts.clientFirestore ?? {};
    } else {
      const loaded = loadDefaultClient();
      this.clientMod = loaded.module;
      this.clientFs = opts.clientFirestore ?? loaded.firestore;
    }
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
    const snap = await this.admin.collection(coll.name).doc(id).get();
    if (!snap.exists) return undefined;
    return coll.schema.parse(snap.data());
  }

  async list<T>(coll: CollectionDef<T>, filter?: Filter<T>): Promise<T[]> {
    let query: AdminQuery = this.admin.collection(coll.name);
    for (const f of this.filterEntries(filter)) {
      query = query.where(f.field, "==", f.value);
    }
    const snap = await query.get();
    return snap.docs.map((d) => coll.schema.parse(d.data()));
  }

  async create<T>(coll: CollectionDef<T>, doc: T): Promise<void> {
    const parsed = coll.schema.parse(doc);
    const id = this.extractId(coll, parsed);
    await this.admin.collection(coll.name).doc(id).set(parsed);
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
    const docRef = this.admin.collection(coll.name).doc(id);
    const snap = await docRef.get();
    if (!snap.exists) {
      throw new Error(`Document ${id} not found in ${coll.name}`);
    }
    const merged = { ...(snap.data() as object), ...patch };
    const parsed = coll.schema.parse(merged);
    await docRef.set(parsed);
  }

  async delete<T>(coll: CollectionDef<T>, id: string): Promise<void> {
    await this.admin.collection(coll.name).doc(id).delete();
  }

  subscribe<T>(
    coll: CollectionDef<T>,
    filter: Filter<T> | undefined,
    onChange: SubscriptionCallback<T>,
  ): Unsubscribe {
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
