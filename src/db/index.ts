export interface CollectionMeta {
  schemaVersion: number;
}

// Minimal adapter-agnostic DB interface. Extended as new collections and
// operations land in future epics.
export interface Db {
  getCollectionMeta(collection: string): Promise<CollectionMeta | undefined>;
  setCollectionMeta(collection: string, meta: CollectionMeta): Promise<void>;
}
