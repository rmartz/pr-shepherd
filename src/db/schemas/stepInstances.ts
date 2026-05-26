import { z } from "zod";
import { StepStatus, StepType } from "./enums";

// Schema for the `stepInstances` collection. See Vision §3.
//
// A step instance is one execution of a single step within a run.
// `logs` is bounded in practice by the executor; the schema does not
// enforce a cap so the runtime can decide what overflow handling looks
// like (see `logFile` for the sidecar overflow path).
const StepMetricsSchema = z.object({
  claudeMs: z.number().nonnegative(),
  activeMs: z.number().nonnegative(),
  scheduleWaitMs: z.number().nonnegative(),
  externalWaitMs: z.number().nonnegative(),
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
  metrics: StepMetricsSchema,
});

export type StepInstance = z.infer<typeof StepInstanceSchema>;
