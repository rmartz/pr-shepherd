import type {
  CollectionDef,
  Db,
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

function matchesFilter<T>(doc: T, filter: Filter<T> | undefined): boolean {
  if (filter === undefined) return true;
  for (const key of Object.keys(filter) as (keyof T)[]) {
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
    for (const sub of this.subsFor(coll)) {
      sub.onChange(all.filter((doc) => matchesFilter(doc, sub.filter)));
    }
  }

  get<T>(coll: CollectionDef<T>, id: string): Promise<T | undefined> {
    return Promise.resolve(this.store(coll).get(id));
  }

  list<T>(coll: CollectionDef<T>, filter?: Filter<T>): Promise<T[]> {
    const all = Array.from(this.store(coll).values());
    return Promise.resolve(all.filter((doc) => matchesFilter(doc, filter)));
  }

  create<T>(coll: CollectionDef<T>, doc: T): Promise<void> {
    const parsed = coll.schema.parse(doc);
    const id = parsed[coll.idField] as unknown as string;
    this.store(coll).set(id, parsed);
    this.notify(coll);
    return Promise.resolve();
  }

  update<T>(
    coll: CollectionDef<T>,
    id: string,
    patch: Partial<T>,
  ): Promise<void> {
    const existing = this.store(coll).get(id);
    if (existing === undefined) {
      throw new Error(`Document ${id} not found in ${coll.name}`);
    }
    const merged = { ...existing, ...patch };
    const parsed = coll.schema.parse(merged);
    this.store(coll).set(id, parsed);
    this.notify(coll);
    return Promise.resolve();
  }

  delete<T>(coll: CollectionDef<T>, id: string): Promise<void> {
    this.store(coll).delete(id);
    this.notify(coll);
    return Promise.resolve();
  }

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
}

export function createInMemoryDb(): Db {
  return new InMemoryDb();
}
