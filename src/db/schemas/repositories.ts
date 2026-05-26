import { z } from "zod";

// Schema for the `repositories` collection. See Vision §3.
//
// Each document represents a GitHub repository the daemon watches.
// `workflowMap` is a free-form object mapping a PR-author pattern
// (e.g. "dependabot[bot]" or a glob "*") to a workflow definition id.
export const RepositorySchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    workflowMap: z.record(z.string(), z.string()),
    concurrencyMax: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type Repository = z.infer<typeof RepositorySchema>;
