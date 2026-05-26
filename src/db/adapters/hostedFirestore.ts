import type {
  CollectionReference,
  DocumentSnapshot,
  Query,
} from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase/admin.js";
import {
  RepositorySchema,
  StepInstanceSchema,
  WorkflowDefinitionSchema,
  WorkflowRunSchema,
} from "@/db/schemas/index.js";
import type { ZodType } from "zod";
import type {
  CollectionMap,
  CollectionName,
  Db,
  DbFilter,
} from "../index.js";

const COLLECTION_SCHEMAS: {
  [C in CollectionName]: ZodType<CollectionMap[C]>;
} = {
  repositories: RepositorySchema,
  stepInstances: StepInstanceSchema,
  workflowDefinitions: WorkflowDefinitionSchema,
  workflowRuns: WorkflowRunSchema,
};

function parseDocument<C extends CollectionName>(
  collection: C,
  id: string,
  data: Record<string, unknown>,
): CollectionMap[C] {
  const schema = COLLECTION_SCHEMAS[collection];
  return schema.parse({ id, ...data });
}

function fromSnapshot<C extends CollectionName>(
  collection: C,
  snap: DocumentSnapshot,
): CollectionMap[C] {
  const data = snap.data();
  if (!data) {
    throw new Error(`Document ${snap.id} in ${collection} has no data`);
  }
  return parseDocument(collection, snap.id, data as Record<string, unknown>);
}

function applyFilters<C extends CollectionName>(
  ref: CollectionReference | Query,
  filters: DbFilter<CollectionMap[C]>[],
): Query {
  let query: Query = ref;
  for (const f of filters) {
    query = query.where(f.field, f.op, f.value);
  }
  return query;
}

export class HostedFirestoreDb implements Db {
  private get firestore() {
    return getAdminFirestore();
  }

  async get<C extends CollectionName>(
    collection: C,
    id: string,
  ): Promise<CollectionMap[C] | undefined> {
    const snap = await this.firestore.collection(collection).doc(id).get();
    if (!snap.exists) return undefined;
    return fromSnapshot(collection, snap);
  }

  async list<C extends CollectionName>(
    collection: C,
    filters?: DbFilter<CollectionMap[C]>[],
  ): Promise<CollectionMap[C][]> {
    const ref = this.firestore.collection(collection);
    const query =
      filters && filters.length > 0 ? applyFilters(ref, filters) : ref;
    const snap = await query.get();
    return snap.docs.map((doc) =>
      fromSnapshot(collection, doc as DocumentSnapshot),
    );
  }

  async create<C extends CollectionName>(
    collection: C,
    doc: CollectionMap[C],
  ): Promise<CollectionMap[C]> {
    const { id, ...data } = doc;
    await this.firestore.collection(collection).doc(id).set(data);
    return doc;
  }

  async update<C extends CollectionName>(
    collection: C,
    id: string,
    patch: Partial<CollectionMap[C]>,
  ): Promise<CollectionMap[C]> {
    const ref = this.firestore.collection(collection).doc(id);
    await ref.update(patch as Record<string, unknown>);
    const updated = await ref.get();
    return fromSnapshot(collection, updated);
  }

  async delete(collection: CollectionName, id: string): Promise<void> {
    await this.firestore.collection(collection).doc(id).delete();
  }

  subscribe<C extends CollectionName>(
    collection: C,
    filters: DbFilter<CollectionMap[C]>[] | undefined,
    onChange: (docs: CollectionMap[C][]) => void,
  ): () => void {
    const ref = this.firestore.collection(collection);
    const query =
      filters && filters.length > 0 ? applyFilters(ref, filters) : ref;

    const unsubscribe = query.onSnapshot((snap) => {
      const docs = snap.docs.map((doc) =>
        fromSnapshot(collection, doc as DocumentSnapshot),
      );
      onChange(docs);
    });

    return unsubscribe;
  }
}
