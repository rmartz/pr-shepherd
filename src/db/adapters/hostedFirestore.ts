import type {
  CollectionDef,
  Db,
  FieldIncrements,
  Filter,
  RangeConstraint,
  SubscriptionCallback,
  Unsubscribe,
} from "../types";
import { AdminSubscriptionManager } from "./firestoreAdminSubscription";
import type { AdminFirestoreLike, AdminQuery } from "./firestoreAdminTypes";
import {
  SUBSCRIBABLE_COLLECTIONS,
  SubscriptionSource,
  extractId,
  filterEntries,
  loadDefaultAdmin,
  loadDefaultClient,
  loadDefaultMakeIncrement,
  stripUndefinedDeep,
  toDocKey,
} from "./hostedFirestoreTypes";
import type {
  ClientFirestoreModule,
  HostedFirestoreDbOptions,
  MakeIncrement,
} from "./hostedFirestoreTypes";

// ---------------------------------------------------------------------------
// Hosted Firestore adapter — `HostedFirestoreDb` implementation.
// Types, constants, and utility helpers: `hostedFirestoreTypes.ts`.
// ---------------------------------------------------------------------------

export class HostedFirestoreDb implements Db {
  // Admin handle: lazy-initialized on first call (single-flight Promise latch).
  private readonly injectedAdmin: AdminFirestoreLike | undefined;
  private adminPromise: Promise<AdminFirestoreLike> | undefined;

  private readonly clientMod: ClientFirestoreModule;
  private readonly clientFs: unknown;

  private readonly subscriptionSource: SubscriptionSource;
  private readonly adminSubscriptions: AdminSubscriptionManager;

  // Increment factory: injected for tests, else lazy-loaded (single-flight).
  private readonly injectedMakeIncrement: MakeIncrement | undefined;
  private makeIncrementPromise: Promise<MakeIncrement> | undefined;

  constructor(opts: HostedFirestoreDbOptions) {
    this.injectedAdmin = opts.adminFirestore;
    this.injectedMakeIncrement = opts.makeIncrement;
    this.subscriptionSource =
      opts.subscriptionSource ?? SubscriptionSource.Client;
    this.adminSubscriptions = new AdminSubscriptionManager({
      loadAdmin: () => this.getAdmin(),
      baseBackoffMs: opts.adminSubscribeBaseBackoffMs,
      maxBackoffMs: opts.adminSubscribeMaxBackoffMs,
    });
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

  private getMakeIncrement(): Promise<MakeIncrement> {
    if (this.injectedMakeIncrement !== undefined) {
      return Promise.resolve(this.injectedMakeIncrement);
    }
    this.makeIncrementPromise ??= loadDefaultMakeIncrement();
    return this.makeIncrementPromise;
  }

  async get<T>(coll: CollectionDef<T>, id: string): Promise<T | undefined> {
    const admin = await this.getAdmin();
    const snap = await admin.collection(coll.name).doc(toDocKey(id)).get();
    if (!snap.exists) return undefined;
    return coll.schema.parse(snap.data());
  }

  async list<T>(
    coll: CollectionDef<T>,
    filter?: Filter<T>,
    range?: RangeConstraint<T>[],
  ): Promise<T[]> {
    const admin = await this.getAdmin();
    let query: AdminQuery = admin.collection(coll.name);
    for (const f of filterEntries(filter)) {
      query = query.where(f.field, "==", f.value);
    }
    // `ComparisonOp`'s string values are exactly Firestore's ordering ops, so
    // each range constraint forwards verbatim — pushing the window to the DB.
    for (const c of range ?? []) {
      query = query.where(c.field, c.op, c.value);
    }
    const snap = await query.get();
    return snap.docs.map((d) => coll.schema.parse(d.data()));
  }

  async create<T>(coll: CollectionDef<T>, doc: T): Promise<void> {
    const parsed = coll.schema.parse(doc);
    const id = extractId(coll, parsed);
    const admin = await this.getAdmin();
    await admin
      .collection(coll.name)
      .doc(toDocKey(id))
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
    const docRef = admin.collection(coll.name).doc(toDocKey(id));
    const snap = await docRef.get();
    if (!snap.exists) {
      throw new Error(`Document ${id} not found in ${coll.name}`);
    }
    const merged = { ...(snap.data() as object), ...patch };
    const parsed = coll.schema.parse(merged);
    await docRef.set(stripUndefinedDeep(parsed));
  }

  async increment<T>(
    coll: CollectionDef<T>,
    id: string,
    deltas: FieldIncrements,
    patch?: Partial<T>,
  ): Promise<void> {
    if (patch !== undefined && coll.idField in patch) {
      const patchedId = (patch as Partial<Record<keyof T, unknown>>)[
        coll.idField
      ];
      if (patchedId !== undefined && patchedId !== id) {
        throw new Error(
          `Cannot change ${coll.name}.${String(coll.idField)} via increment (id "${id}" → "${String(patchedId)}"); delete and re-create instead.`,
        );
      }
    }
    // Build a single `update` patch where each dotted field path carries a
    // `FieldValue.increment` sentinel. Firestore applies these server-side
    // and atomically, so concurrent increments on the same document never
    // race the way a `get` + `update` read-modify-write would. We skip the
    // fetch-merge-validate round-trip `update` does because the merged value
    // is only known after the server applies the increment.
    const makeIncrement = await this.getMakeIncrement();
    const updatePatch: Record<string, unknown> = {};
    for (const [path, by] of Object.entries(deltas)) {
      updatePatch[path] = makeIncrement(by);
    }
    if (patch !== undefined) {
      const cleaned = stripUndefinedDeep(patch) as Record<string, unknown>;
      Object.assign(updatePatch, cleaned);
    }
    const admin = await this.getAdmin();
    await admin.collection(coll.name).doc(toDocKey(id)).update(updatePatch);
  }

  async delete<T>(coll: CollectionDef<T>, id: string): Promise<void> {
    const admin = await this.getAdmin();
    await admin.collection(coll.name).doc(toDocKey(id)).delete();
  }

  subscribe<T>(
    coll: CollectionDef<T>,
    filter: Filter<T> | undefined,
    onChange: SubscriptionCallback<T>,
  ): Unsubscribe {
    if (this.subscriptionSource === SubscriptionSource.Admin) {
      // The daemon path: service-account credentials bypass rules, so any
      // collection is subscribable. Listener lifecycle, backoff re-subscribe,
      // and Zod decoding live in the subscription manager.
      return this.adminSubscriptions.subscribe(coll, filter, onChange);
    }
    if (!SUBSCRIBABLE_COLLECTIONS.has(coll.name)) {
      throw new Error(
        `Collection "${coll.name}" is not subscribable from the client SDK — firestore.rules denies client reads. Use the admin path (list/get) on the daemon side instead.`,
      );
    }
    const base = this.clientMod.collection(this.clientFs, coll.name);
    const constraints = filterEntries(filter).map((f) =>
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

  // Detach every active admin subscription. The daemon calls this on graceful
  // shutdown so no Firestore stream (or pending backoff retry) outlives the
  // process. A no-op when no admin subscriptions are open.
  closeSubscriptions(): void {
    this.adminSubscriptions.closeAll();
  }
}

export function createHostedFirestoreDb(
  opts: HostedFirestoreDbOptions = {},
): Db {
  return new HostedFirestoreDb(opts);
}
