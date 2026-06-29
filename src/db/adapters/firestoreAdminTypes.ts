// Minimal structural types for the `firebase-admin/firestore` surface the
// hosted adapter consumes. Narrow enough that test fakes can implement them,
// broad enough that the real admin SDK satisfies them. Shared between the
// CRUD path (`hostedFirestore.ts`) and the admin subscription manager
// (`firestoreAdminSubscription.ts`).

export interface AdminDocSnapshot {
  exists: boolean;
  data: () => unknown;
}

export interface AdminDocRef {
  get: () => Promise<AdminDocSnapshot>;
  set: (data: unknown) => Promise<unknown>;
  update: (patch: Record<string, unknown>) => Promise<unknown>;
  delete: () => Promise<unknown>;
}

export interface AdminQuerySnapshot {
  docs: { id: string; data: () => unknown }[];
}

// The subset of Firestore's `WhereFilterOp` the adapter emits: equality for
// the existing `Filter` path, plus the four ordering operators for range
// constraints. `ComparisonOp`'s string values match these so they pass
// through verbatim.
export type AdminWhereOp = "==" | ">" | ">=" | "<" | "<=";

export interface AdminQuery {
  where: (field: string, op: AdminWhereOp, value: unknown) => AdminQuery;
  get: () => Promise<AdminQuerySnapshot>;
  // Admin-SDK realtime listener. Returns a synchronous unsubscribe handle.
  // `onError` receives a transient stream failure; after it fires no further
  // `onNext` callbacks occur on that listener (matching the admin SDK
  // contract), so the caller must re-subscribe to recover.
  onSnapshot: (
    onNext: (snap: AdminQuerySnapshot) => void,
    onError: (err: Error) => void,
  ) => () => void;
}

export interface AdminCollection extends AdminQuery {
  doc: (id: string) => AdminDocRef;
}

export interface AdminFirestoreLike {
  collection: (name: string) => AdminCollection;
}
