import { z } from "zod";

export enum WorkflowRunStatus {
  Cancelled = "cancelled",
  Completed = "completed",
  Failed = "failed",
  Pending = "pending",
  Running = "running",
}

const WorkflowRunMetricsSchema = z.object({
  totalClaudeMs: z.number().int().nonnegative(),
  totalActiveMs: z.number().int().nonnegative(),
  totalScheduleWaitMs: z.number().int().nonnegative(),
  totalExternalWaitMs: z.number().int().nonnegative(),
});

export const WorkflowRunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowVersion: z.number().int().nonnegative(),
  repo: z.string(),
  prNumber: z.number().int().positive(),
  prTitle: z.string(),
  status: z.enum(WorkflowRunStatus),
  parentRunId: z.string().optional(),
  childRunIds: z.array(z.string()),
  context: z.record(z.string(), z.unknown()),
  currentStepId: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  metrics: WorkflowRunMetricsSchema,
});

export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type WorkflowRunMetrics = z.infer<typeof WorkflowRunMetricsSchema>;
