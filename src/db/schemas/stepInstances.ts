import { z } from "zod";

export enum StepType {
  ClaudeSkill = "claude_skill",
  Decision = "decision",
  Fork = "fork",
  GithubApi = "github_api",
  WaitExternal = "wait_external",
}

export enum StepStatus {
  Cancelled = "cancelled",
  Completed = "completed",
  Failed = "failed",
  Pending = "pending",
  Queued = "queued",
  Running = "running",
  Skipped = "skipped",
  Waiting = "waiting",
}

const StepInstanceMetricsSchema = z.object({
  claudeMs: z.number().int().nonnegative(),
  activeMs: z.number().int().nonnegative(),
  scheduleWaitMs: z.number().int().nonnegative(),
  externalWaitMs: z.number().int().nonnegative(),
});

export const StepInstanceSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepDefinitionId: z.string(),
  stepType: z.enum(StepType),
  status: z.enum(StepStatus),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
  logs: z.array(z.string()),
  logFile: z.string().optional(),
  retryCount: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  error: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  queuedAt: z.number().int().nonnegative().optional(),
  startedAt: z.number().int().nonnegative().optional(),
  waitingAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
  heartbeatAt: z.number().int().nonnegative().optional(),
  metrics: StepInstanceMetricsSchema,
});

export type StepInstance = z.infer<typeof StepInstanceSchema>;
export type StepInstanceMetrics = z.infer<typeof StepInstanceMetricsSchema>;
