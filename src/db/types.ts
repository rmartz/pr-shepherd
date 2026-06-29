import type { ZodType } from "zod";

// Partial-match filter: every specified key/value must equal the
// corresponding field on the document. An undefined filter matches all
// documents in the collection.
export type Filter<T> = Partial<T>;

// Comparison operators for a range constraint. Kept alphabetical to
// minimize merge conflicts. The string values match Firestore's
// `WhereFilterOp` so the hosted adapter forwards them to `query.where()`
// verbatim, while the in-memory adapter evaluates them against each doc.
export enum ComparisonOp {
  GreaterThan = ">",
  GreaterThanOrEqual = ">=",
  LessThan = "<",
  LessThanOrEqual = "<=",
}

// A single range predicate over one field: `doc[field] <op> value`. Unlike
// `Filter` (equality only), this expresses ordering comparisons such as
// `receivedAt >= cutoff`, so an append-only collection can be scanned over a
// bounded window at the DB layer rather than loaded in full and filtered in
// memory. The distributive mapped type correlates `value`'s type to the
// specific chosen `field`, preventing silent type errors at call sites.
export type RangeConstraint<T> = {
  [K in keyof T & string]: { field: K; op: ComparisonOp; value: T[K] };
}[keyof T & string];

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

// Map of dotted field paths to numeric deltas applied atomically by
// `Db.increment`. A path like `"metrics.totalClaudeMs"` adds its value to
// the nested numeric field (treating a missing field as 0). Used for the
// run-level metrics rollup so concurrent step completions never drop a delta
// to a read-modify-write race.
export type FieldIncrements = Record<string, number>;

// Unsubscribe handle returned by `subscribe`. Idempotent.
export type Unsubscribe = () => void;

// Adapter-agnostic database contract. Both the daemon (admin SDK) and
// the UI (client SDK) consume this interface; the hosted Firestore
// adapter from #38, the emulator adapter from #39, and any future
// LevelDB adapter all implement it.
export interface Db {
  get<T>(coll: CollectionDef<T>, id: string): Promise<T | undefined>;
  // `filter` matches on field equality (unchanged). `range` adds ordering
  // constraints (e.g. `receivedAt >= cutoff`) ANDed with the equality filter,
  // letting an unbounded append-only collection be scanned over a bounded
  // window at the DB layer instead of loaded in full and filtered in memory.
  list<T>(
    coll: CollectionDef<T>,
    filter?: Filter<T>,
    range?: RangeConstraint<T>[],
  ): Promise<T[]>;
  create<T>(coll: CollectionDef<T>, doc: T): Promise<void>;
  update<T>(
    coll: CollectionDef<T>,
    id: string,
    patch: Partial<T>,
  ): Promise<void>;
  // Atomically add `deltas` to nested numeric fields, optionally setting
  // non-numeric fields (e.g. `updatedAt`) via `patch` in the same write.
  // Unlike `get` + `update`, concurrent `increment` calls on the same
  // document never drop a delta: the Firestore adapter wires each path to
  // `FieldValue.increment(n)`, and the in-memory adapter serializes the
  // read-modify-write under a per-document mutex.
  increment<T>(
    coll: CollectionDef<T>,
    id: string,
    deltas: FieldIncrements,
    patch?: Partial<T>,
  ): Promise<void>;
  delete<T>(coll: CollectionDef<T>, id: string): Promise<void>;
  subscribe<T>(
    coll: CollectionDef<T>,
    filter: Filter<T> | undefined,
    onChange: SubscriptionCallback<T>,
  ): Unsubscribe;
  // Detach every active subscription. Called on graceful daemon shutdown so no
  // realtime listener (or pending re-subscribe) outlives the process. A no-op
  // when no subscriptions are open.
  closeSubscriptions(): void;
}
