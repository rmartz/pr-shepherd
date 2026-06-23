import { z } from "zod";
import { EventType } from "./enums";

// Schema for the `eventStream` collection (#109 self-observability).
//
// An append-only, per-event audit log. Each document records one
// auditable moment in a run's lifecycle: the deciding inputs (PR +
// HEAD SHA + the gate that decided the action), the event's outcome,
// how many attempts produced it, and any captured logs. The stream is
// the queryable substrate the post-run self-analysis reads to detect
// anomalies — it is never a source of truth the scheduler routes off,
// only a record of what already happened.
//
// `runId` ties an event back to its `workflowRuns` document; `repo` and
// `prNumber` are denormalized onto the event so analysis can group by PR
// without a join. `headSha` and `decidingGate` are optional because not
// every event has a SHA in hand (e.g. a run-blocked event) or a gate
// that produced it (e.g. a raw step start).
export const EventRecordSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    repo: z.string(),
    prNumber: z.number().int().nonnegative(),
    headSha: z.string().optional(),
    decidingGate: z.string().optional(),
    eventType: z.enum(EventType),
    // The step that produced the event, when one did. Present for
    // step_* events; absent for run-level events.
    stepInstanceId: z.string().optional(),
    // Attempts that produced this outcome (1 = first try, 2 = one retry).
    attempts: z.number().int().positive(),
    // Free-form outcome label drawn from the producing step's output
    // (e.g. "approved", "process_restart", "timeout"). Optional because
    // some events are pure phase transitions with no verdict.
    outcome: z.string().optional(),
    logs: z.array(z.string()),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type EventRecord = z.infer<typeof EventRecordSchema>;
