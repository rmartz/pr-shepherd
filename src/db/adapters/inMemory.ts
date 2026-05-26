import type {
  CollectionMap,
  CollectionName,
  Db,
  DbFilter,
} from "../index.js";

type Store = {
  [C in CollectionName]: Map<string, CollectionMap[C]>;
};

function matchesFilters<T extends CollectionMap[CollectionName]>(
  doc: T,
  filters: DbFilter<T>[],
): boolean {
  return filters.every((f) => {
    const docValue = (doc as Record<string, unknown>)[f.field];
    switch (f.op) {
      case "==":
        return docValue === f.value;
      case "!=":
        return docValue !== f.value;
      case "<":
        return (
          typeof docValue === "number" &&
          typeof f.value === "number" &&
          docValue < f.value
        );
      case "<=":
        return (
          typeof docValue === "number" &&
          typeof f.value === "number" &&
          docValue <= f.value
        );
      case ">":
        return (
          typeof docValue === "number" &&
          typeof f.value === "number" &&
          docValue > f.value
        );
      case ">=":
        return (
          typeof docValue === "number" &&
          typeof f.value === "number" &&
          docValue >= f.value
        );
    }
  });
}

export class InMemoryDb implements Db {
  private readonly store = {
    repositories: new Map<string, CollectionMap["repositories"]>(),
    stepInstances: new Map<string, CollectionMap["stepInstances"]>(),
    workflowDefinitions: new Map<
      string,
      CollectionMap["workflowDefinitions"]
    >(),
    workflowRuns: new Map<string, CollectionMap["workflowRuns"]>(),
  } satisfies Store;

  private readonly listeners = new Map<
    string,
    Set<(docs: CollectionMap[CollectionName][]) => void>
  >();

  private notify(collection: CollectionName): void {
    const listeners = this.listeners.get(collection);
    if (!listeners) return;

    const allDocs = Array.from(
      (this.store[collection] as Map<string, CollectionMap[CollectionName]>).values(),
    );

    for (const listener of listeners) {
      listener(allDocs);
    }
  }

  get<C extends CollectionName>(
    collection: C,
    id: string,
  ): Promise<CollectionMap[C] | undefined> {
    return Promise.resolve(
      (this.store[collection] as Map<string, CollectionMap[C]>).get(id),
    );
  }

  list<C extends CollectionName>(
    collection: C,
    filters?: DbFilter<CollectionMap[C]>[],
  ): Promise<CollectionMap[C][]> {
    const docs = Array.from(
      (this.store[collection] as Map<string, CollectionMap[C]>).values(),
    );
    if (!filters || filters.length === 0) return Promise.resolve(docs);
    return Promise.resolve(docs.filter((doc) => matchesFilters(doc, filters)));
  }

  create<C extends CollectionName>(
    collection: C,
    doc: CollectionMap[C],
  ): Promise<CollectionMap[C]> {
    (this.store[collection] as Map<string, CollectionMap[C]>).set(doc.id, doc);
    this.notify(collection);
    return Promise.resolve(doc);
  }

  update<C extends CollectionName>(
    collection: C,
    id: string,
    patch: Partial<CollectionMap[C]>,
  ): Promise<CollectionMap[C]> {
    const existing = (
      this.store[collection] as Map<string, CollectionMap[C]>
    ).get(id);
    if (!existing) {
      return Promise.reject(
        new Error(`Document ${id} not found in ${collection}`),
      );
    }
    const updated = { ...existing, ...patch };
    (this.store[collection] as Map<string, CollectionMap[C]>).set(id, updated);
    this.notify(collection);
    return Promise.resolve(updated);
  }

  delete(collection: CollectionName, id: string): Promise<void> {
    (this.store[collection] as Map<string, CollectionMap[CollectionName]>).delete(id);
    this.notify(collection);
    return Promise.resolve();
  }

  subscribe<C extends CollectionName>(
    collection: C,
    filters: DbFilter<CollectionMap[C]>[] | undefined,
    onChange: (docs: CollectionMap[C][]) => void,
  ): () => void {
    const wrappedListener = (docs: CollectionMap[CollectionName][]) => {
      const typed = docs as CollectionMap[C][];
      const filtered =
        filters && filters.length > 0
          ? typed.filter((doc) => matchesFilters(doc, filters))
          : typed;
      onChange(filtered);
    };

    if (!this.listeners.has(collection)) {
      this.listeners.set(collection, new Set());
    }
    this.listeners.get(collection)?.add(wrappedListener);

    const allDocs = Array.from(
      (this.store[collection] as Map<string, CollectionMap[C]>).values(),
    );
    const initial =
      filters && filters.length > 0
        ? allDocs.filter((doc) => matchesFilters(doc, filters))
        : allDocs;
    onChange(initial);

    return () => {
      this.listeners.get(collection)?.delete(wrappedListener);
    };
  }
}
