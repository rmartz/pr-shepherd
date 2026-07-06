import { z } from "zod";
import { StepStatus, StepType } from "./enums";

// Schema for the `stepInstances` collection. See Vision §3.
//
// A step instance is one execution of a single step within a run.
// `logs` is bounded in practice by the executor; the schema does not
// enforce a cap so the runtime can decide what overflow handling looks
// like (see `logFile` for the sidecar overflow path).
const StepMetricsSchema = z
  .object({
    claudeMs: z.number().nonnegative(),
    activeMs: z.number().nonnegative(),
    scheduleWaitMs: z.number().nonnegative(),
    externalWaitMs: z.number().nonnegative(),
  })
  .strict();

export const StepInstanceSchema = z
  .object({
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
  })
  .strict();

export type StepInstance = z.infer<typeof StepInstanceSchema>;

// The default per-step retry budget seeded on a new step instance's
// `maxRetries` when the caller does not override it. Shared by every module
// that creates a step (enrollment, advance-on-completion, the webhook
// derivation trigger) so the default never drifts between them (#287). Distinct
// from `github_api`'s own per-action retry cap.
export const DEFAULT_STEP_MAX_RETRIES = 3;
