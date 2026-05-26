import type { ZodType } from "zod";

// Partial-match filter: every specified key/value must equal the
// corresponding field on the document. An undefined filter matches all
// documents in the collection.
export type Filter<T> = Partial<T>;

// A typed identifier for a collection. Carries the runtime name (used
// by adapters to key storage) and the Zod schema (used by adapters to
// validate documents on the way in and out).
export interface CollectionDef<T> {
  name: string;
  schema: ZodType<T>;
  idField: keyof T;
}

// Callback shape used by `subscribe` — receives the current snapshot
// of documents matching the filter on every change.
export type SubscriptionCallback<T> = (docs: T[]) => void;

// Unsubscribe handle returned by `subscribe`. Idempotent.
export type Unsubscribe = () => void;

// Adapter-agnostic database contract. Both the daemon (admin SDK) and
// the UI (client SDK) consume this interface; the hosted Firestore
// adapter from #38, the emulator adapter from #39, and any future
// LevelDB adapter all implement it.
export interface Db {
  get<T>(coll: CollectionDef<T>, id: string): Promise<T | undefined>;
  list<T>(coll: CollectionDef<T>, filter?: Filter<T>): Promise<T[]>;
  create<T>(coll: CollectionDef<T>, doc: T): Promise<void>;
  update<T>(
    coll: CollectionDef<T>,
    id: string,
    patch: Partial<T>,
  ): Promise<void>;
  delete<T>(coll: CollectionDef<T>, id: string): Promise<void>;
  subscribe<T>(
    coll: CollectionDef<T>,
    filter: Filter<T> | undefined,
    onChange: SubscriptionCallback<T>,
  ): Unsubscribe;
}
