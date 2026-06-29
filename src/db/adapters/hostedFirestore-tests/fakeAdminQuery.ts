import type { ClientFirestoreModule } from "../hostedFirestoreTypes";

// ---------------------------------------------------------------------------
// Fake `firebase-admin/firestore` — just enough surface for the adapter.
// Stores per-collection docs in a Map; supports get/set/update/delete and
// `where(field, op, value)` chained queries.
// ---------------------------------------------------------------------------

interface FakeQuerySnapshotDoc {
  id: string;
  data: () => unknown;
}

interface FakeQuerySnapshot {
  docs: FakeQuerySnapshotDoc[];
}

// Fake `FieldValue.increment` sentinel. The adapter's `increment()` is
// constructed with `makeIncrement` so unit tests can recognize the sentinel
// without loading the real admin SDK; the fake `update` below applies it.
export class FakeIncrement {
  constructor(public readonly by: number) {}
}

// Injectable `makeIncrement` that produces a `FakeIncrement` sentinel — the
// hosted adapter stores these as opaque values in the `update` patch, exactly
// as it would store the real `FieldValue.increment(n)`.
export function makeFakeIncrement(by: number): FakeIncrement {
  return new FakeIncrement(by);
}

function getNested(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveFieldValue(current: unknown, value: unknown): unknown {
  if (value instanceof FakeIncrement) {
    return (typeof current === "number" ? current : 0) + value.by;
  }
  return value;
}

function applyNestedPath(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let container = obj;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      container[segment] = resolveFieldValue(container[segment], value);
      return;
    }
    const existing = container[segment];
    if (existing === null || typeof existing !== "object") {
      container[segment] = {};
    }
    container = container[segment] as Record<string, unknown>;
  });
}

interface FakeWhere {
  field: string;
  op: string;
  value: unknown;
}

// Evaluate one `where` clause against a doc, mirroring Firestore's operators.
function matchesWhere(data: Record<string, unknown>, f: FakeWhere): boolean {
  const actual = data[f.field];
  switch (f.op) {
    case "==":
      return actual === f.value;
    case ">":
      return (actual as number) > (f.value as number);
    case ">=":
      return (actual as number) >= (f.value as number);
    case "<":
      return (actual as number) < (f.value as number);
    case "<=":
      return (actual as number) <= (f.value as number);
    default:
      throw new Error(`Fake does not support op ${f.op}`);
  }
}

export class FakeAdminQuery {
  constructor(
    private readonly store: Map<string, unknown>,
    private readonly filters: FakeWhere[] = [],
  ) {}

  where(field: string, op: string, value: unknown): FakeAdminQuery {
    return new FakeAdminQuery(this.store, [
      ...this.filters,
      { field, op, value },
    ]);
  }

  // Admin-SDK realtime listener fake. Mirrors the real `Query.onSnapshot`:
  // emits the current (filtered) snapshot immediately, re-dispatches on every
  // admin-side mutation via the shared `listeners` registry, and returns a
  // synchronous unsubscribe. The `onError` callback is omitted — backoff and
  // error recovery are covered in `firestoreAdminSubscription.spec.ts`; this
  // fake only needs the happy path so the hosted-adapter CRUD tests typecheck.
  onSnapshot(
    onNext: (snap: { docs: { id: string; data: () => unknown }[] }) => void,
  ): () => void {
    const filters = this.filters;
    const store = this.store;
    const dispatch = (): void => {
      const docs = Array.from(store.entries())
        .filter(([, data]) =>
          filters.every((f) =>
            matchesWhere(data as Record<string, unknown>, f),
          ),
        )
        .map(([id, data]) => ({ id, data: () => data }));
      onNext({ docs });
    };
    dispatch();
    const existing = listeners.get(store) ?? [];
    existing.push(dispatch);
    listeners.set(store, existing);
    return () => {
      const list = listeners.get(store);
      if (!list) return;
      const idx = list.indexOf(dispatch);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(): Promise<FakeQuerySnapshot> {
    const docs: FakeQuerySnapshotDoc[] = [];
    for (const [id, data] of this.store.entries()) {
      const match = this.filters.every((f) =>
        matchesWhere(data as Record<string, unknown>, f),
      );
      if (match) docs.push({ id, data: () => data });
    }
    return { docs };
  }
}

export class FakeAdminDocRef {
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
    // Mirror the admin SDK's `update`: dotted keys address nested fields, and
    // `FieldValue.increment` sentinels (here `FakeIncrement`) add to the
    // current numeric value rather than replacing it. Plain keys are set as-is.
    const next = structuredClone(existing as Record<string, unknown>);
    for (const [key, value] of Object.entries(patch)) {
      if (key.includes(".")) {
        applyNestedPath(next, key.split("."), value);
      } else {
        next[key] = resolveFieldValue(getNested(next, [key]), value);
      }
    }
    this.store.set(this.id, next);
    triggerListeners(this.store);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(): Promise<void> {
    this.store.delete(this.id);
    triggerListeners(this.store);
  }
}

export class FakeAdminCollection extends FakeAdminQuery {
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
export const listeners = new Map<
  Map<string, unknown>,
  ((docs: unknown[]) => void)[]
>();

export function triggerListeners(store: Map<string, unknown>): void {
  const cbs = listeners.get(store);
  if (!cbs) return;
  const all = Array.from(store.entries()).map(([id, data]) => ({ id, data }));
  for (const cb of [...cbs]) cb(all);
}

export function makeFakeAdmin(): {
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

export function makeFakeClient(
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
