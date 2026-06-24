import type {
  CollectionDef,
  Db,
  FieldIncrements,
  Filter,
  SubscriptionCallback,
  Unsubscribe,
} from "../types";

// In-memory adapter used by engine/executor tests in Epics 3-5 that
// need a Db without a real Firestore. Storage is a `Map<id, doc>` per
// collection; subscriptions fan out on every mutation.
//
// Not intended for production. The hosted Firestore adapter (#38) is
// the production path; the emulator adapter (#39) shares its code via
// a startup-time `connectFirestoreEmulator()` switch.

interface Subscription<T> {
  filter: Filter<T> | undefined;
  onChange: SubscriptionCallback<T>;
}

// Add `by` to the numeric leaf addressed by the dotted `path`, creating
// intermediate objects and treating a missing leaf as 0 — the in-memory
// analogue of `FieldValue.increment` on a dotted field path.
function addAtPath(
  obj: Record<string, unknown>,
  path: string,
  by: number,
): void {
  const segments = path.split(".");
  let container = obj;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      const current = container[segment];
      container[segment] = (typeof current === "number" ? current : 0) + by;
      return;
    }
    const existing = container[segment];
    if (existing === null || typeof existing !== "object") {
      container[segment] = {};
    }
    container = container[segment] as Record<string, unknown>;
  });
}

function matchesFilter<T>(doc: T, filter: Filter<T> | undefined): boolean {
  if (filter === undefined) return true;
  for (const key of Object.keys(filter) as (keyof T)[]) {
    // Skip keys whose filter value is `undefined` — callers commonly
    // spread optional values (e.g. `{ owner }` where `owner` is
    // `string | undefined`) and expect those keys to mean "not
    // specified", not "match only docs whose field is `undefined`".
    if (filter[key] === undefined) continue;
    if (doc[key] !== filter[key]) return false;
  }
  return true;
}

class InMemoryDb implements Db {
  private readonly stores = new Map<string, Map<string, unknown>>();
  private readonly subs = new Map<string, Subscription<unknown>[]>();

  private store<T>(coll: CollectionDef<T>): Map<string, T> {
    let s = this.stores.get(coll.name);
    if (s === undefined) {
      s = new Map<string, unknown>();
      this.stores.set(coll.name, s);
    }
    return s as Map<string, T>;
  }

  private subsFor<T>(coll: CollectionDef<T>): Subscription<T>[] {
    let list = this.subs.get(coll.name);
    if (list === undefined) {
      list = [];
      this.subs.set(coll.name, list);
    }
    return list;
  }

  private notify<T>(coll: CollectionDef<T>): void {
    const all = Array.from(this.store(coll).values());
    // Snapshot the subscription list before iterating: an `onChange`
    // callback that calls its own `unsubscribe()` would splice the
    // live array mid-iteration and cause the next subscriber to be
    // skipped (the for-of iterator advances past the shifted-in entry).
    for (const sub of [...this.subsFor(coll)]) {
      sub.onChange(all.filter((doc) => matchesFilter(doc, sub.filter)));
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

  // Methods that mutate or validate are declared `async` so synchronous
  // throws (Zod parse errors, id guards) surface as rejected promises
  // rather than escaping at the call site — callers consistently see
  // one failure shape regardless of the underlying adapter's I/O.
  // `require-await` would flag the no-`await` methods here, but the
  // wrap is the whole point — disabling locally.
  /* eslint-disable @typescript-eslint/require-await */

  async get<T>(coll: CollectionDef<T>, id: string): Promise<T | undefined> {
    return this.store(coll).get(id);
  }

  async list<T>(coll: CollectionDef<T>, filter?: Filter<T>): Promise<T[]> {
    const all = Array.from(this.store(coll).values());
    return all.filter((doc) => matchesFilter(doc, filter));
  }

  async create<T>(coll: CollectionDef<T>, doc: T): Promise<void> {
    const parsed = coll.schema.parse(doc);
    const id = this.extractId(coll, parsed);
    this.store(coll).set(id, parsed);
    this.notify(coll);
  }

  async update<T>(
    coll: CollectionDef<T>,
    id: string,
    patch: Partial<T>,
  ): Promise<void> {
    const existing = this.store(coll).get(id);
    if (existing === undefined) {
      throw new Error(`Document ${id} not found in ${coll.name}`);
    }
    // Reject patches that try to change the id field — the Map key
    // would diverge from the document's stored id, leaving the doc
    // unreachable by its new id and inconsistent for subscribers.
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
    const merged = { ...existing, ...patch };
    const parsed = coll.schema.parse(merged);
    this.store(coll).set(id, parsed);
    this.notify(coll);
  }

  async increment<T>(
    coll: CollectionDef<T>,
    id: string,
    deltas: FieldIncrements,
    patch?: Partial<T>,
  ): Promise<void> {
    const existing = this.store(coll).get(id);
    if (existing === undefined) {
      throw new Error(`Document ${id} not found in ${coll.name}`);
    }
    // The read-apply-write below runs synchronously with no `await` between
    // the read and the write, so it cannot interleave with another
    // `increment` on the same document — JS's single-threaded event loop is
    // the mutex. This is what makes concurrent run-metric rollups land every
    // delta where the old `get` + `update` read-modify-write dropped one.
    const merged = { ...(existing as Record<string, unknown>) };
    for (const [path, by] of Object.entries(deltas)) {
      addAtPath(merged, path, by);
    }
    if (patch !== undefined) {
      Object.assign(merged, patch);
    }
    const parsed = coll.schema.parse(merged);
    this.store(coll).set(id, parsed);
    this.notify(coll);
  }

  async delete<T>(coll: CollectionDef<T>, id: string): Promise<void> {
    this.store(coll).delete(id);
    this.notify(coll);
  }

  /* eslint-enable @typescript-eslint/require-await */

  subscribe<T>(
    coll: CollectionDef<T>,
    filter: Filter<T> | undefined,
    onChange: SubscriptionCallback<T>,
  ): Unsubscribe {
    const list = this.subsFor(coll);
    const sub: Subscription<T> = { filter, onChange };
    list.push(sub);
    // Emit the current snapshot immediately so subscribers don't need
    // a separate initial `list` call.
    const all = Array.from(this.store(coll).values());
    onChange(all.filter((doc) => matchesFilter(doc, filter)));
    return () => {
      const idx = list.indexOf(sub);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  // Drop every registered subscription so a graceful-shutdown teardown leaves
  // no live callback. Mirrors the hosted adapter's listener detach.
  closeSubscriptions(): void {
    this.subs.clear();
  }
}

export function createInMemoryDb(): Db {
  return new InMemoryDb();
}
