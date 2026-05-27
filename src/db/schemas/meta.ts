import { z } from "zod";

// Schema for the internal `_meta` collection. The migrations runner
// (#40) writes one document per daemon-managed collection, keyed by the
// collection's name, recording the highest applied migration version.
//
// `id` is the collection name (e.g. `"workflowRuns"`) so the meta doc
// is reachable via `db.get(Collections.meta, "workflowRuns")`.
export const MetaDocSchema = z
  .object({
    id: z.string().min(1),
    collectionName: z.string().min(1),
    schemaVersion: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type MetaDoc = z.infer<typeof MetaDocSchema>;
