import { randomUUID } from "node:crypto";
import { Collections, type Db, type EventRecord, EventType } from "@/db";

// Fields the caller supplies when recording an event. The recorder fills
// in the `id` and `createdAt` so callers never hand-roll identity or
// clock reads — keeping the audit log append-only and tamper-resistant.
export interface RecordEventInput {
  runId: string;
  repo: string;
  prNumber: number;
  eventType: EventType;
  attempts: number;
  headSha?: string;
  decidingGate?: string;
  stepInstanceId?: string;
  outcome?: string;
  logs?: string[];
}

// Append one event to the `eventStream` collection (#109). The recorder
// is the single write path into the audit log: it stamps a fresh id and
// timestamp so every record is uniquely keyed and ordered, then persists
// through the adapter-agnostic `Db` interface.
//
// `now` is injectable so tests get deterministic timestamps without
// stubbing the global clock. It defaults to `Date.now`.
export async function recordEvent(
  db: Db,
  input: RecordEventInput,
  now: () => number = Date.now,
): Promise<EventRecord> {
  const record: EventRecord = {
    id: randomUUID(),
    runId: input.runId,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    decidingGate: input.decidingGate,
    eventType: input.eventType,
    stepInstanceId: input.stepInstanceId,
    attempts: input.attempts,
    outcome: input.outcome,
    logs: input.logs ?? [],
    createdAt: now(),
  };
  await db.create(Collections.eventStream, record);
  return record;
}

// Read back every event for one run, oldest first. Self-analysis reads
// the stream per-run to detect anomalies; ordering by `createdAt` lets
// detectors reason about sequence (e.g. timeout-then-fast-retry).
export async function listRunEvents(
  db: Db,
  runId: string,
): Promise<EventRecord[]> {
  const events = await db.list(Collections.eventStream, { runId });
  return [...events].sort((a, b) => a.createdAt - b.createdAt);
}
