import { z } from "zod";

// Schema for the internal `_meta` collection. The migrations runner
// (#40) writes one document per daemon-managed collection, keyed by the
// collection's name, recording the highest applied migration version.
//
// `id` is the collection name (e.g. `"workflowRuns"`) so the meta doc
// is reachable via `db.get(Collections.meta, "workflowRuns")`.
//
// `schemaVersion` is `.positive()` (≥ 1) rather than `.nonnegative()`
// to match the runner's invariant: `validateMigrations` rejects any
// migration with version < 1, so the runner never stamps `0`. The
// "no migrations applied yet" sentinel is the absence of a meta doc,
// not a `schemaVersion: 0` document. Allowing `0` here would mean a
// rogue write could create a doc that `readCurrentVersion` reads as
// `0` — indistinguishable from "no doc" — causing the runner to
// re-apply every migration thinking none had been applied.
export const MetaDocSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type MetaDoc = z.infer<typeof MetaDocSchema>;
