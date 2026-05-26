import { z } from "zod";

export const WorkflowDefinitionSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  version: z.number().int().nonnegative(),
  content: z.string(),
  definition: z.record(z.string(), z.unknown()),
  createdAt: z.number().int().nonnegative(),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
