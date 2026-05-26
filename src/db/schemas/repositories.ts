import { z } from "zod";

export const RepositorySchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  workflowMap: z.record(z.string(), z.string()),
  concurrencyMax: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
});

export type Repository = z.infer<typeof RepositorySchema>;
