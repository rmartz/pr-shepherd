import { z } from "zod";
import { RunStatus } from "./enums";

// Schema for the `workflowRuns` collection. See Vision §3.
//
// A workflow run is one execution of a workflow definition for one PR.
// `context` is a mutable shared state object passed between steps and
// updated as steps complete; it is intentionally unconstrained at the
// schema level (steps own their own context contracts).
const RunMetricsSchema = z
  .object({
    totalClaudeMs: z.number().nonnegative(),
    totalActiveMs: z.number().nonnegative(),
    totalScheduleWaitMs: z.number().nonnegative(),
    totalExternalWaitMs: z.number().nonnegative(),
  })
  .strict();

export const WorkflowRunSchema = z
  .object({
    id: z.string(),
    workflowId: z.string(),
    workflowVersion: z.number().int().nonnegative(),
    repo: z.string(),
    prNumber: z.number().int().nonnegative(),
    prTitle: z.string(),
    status: z.enum(RunStatus),
    // Operator-issued hold (#121). When `true`, the scheduler skips admitting
    // this run's pending steps — a derived hold the gate/scheduler model
    // honors. A `resume_run` command clears it, and admission auto-resumes on
    // the next tick with no manual unpark. Absent on legacy runs (treated as
    // not paused); a migration backfills `false`.
    paused: z.boolean().optional(),
    parentRunId: z.string().optional(),
    childRunIds: z.array(z.string()),
    context: z.record(z.string(), z.unknown()),
    currentStepId: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
    metrics: RunMetricsSchema,
  })
  .strict();

export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
