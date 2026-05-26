import { z } from "zod";

// Schema for the `workflowDefinitions` collection. See Vision §3.
//
// This is a reference copy collection — the engine's source of truth
// remains the YAML files on disk. A document is written here whenever
// a new run starts so that the exact definition version can be audited
// later, even after the YAML evolves.
export const WorkflowDefinitionSchema = z
  .object({
    id: z.string(),
    workflowId: z.string(),
    version: z.number().int().nonnegative(),
    source: z.string(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
