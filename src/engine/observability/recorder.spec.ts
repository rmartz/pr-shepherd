import { describe, expect, it } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { EventType } from "@/db/schemas";
import { listRunEvents, recordEvent } from "./recorder";

describe("recordEvent (event taxonomy)", () => {
  it("persists the supplied inputs verbatim", async () => {
    const db = createInMemoryDb();

    const record = await recordEvent(
      db,
      {
        runId: "run-7",
        repo: "owner/repo",
        prNumber: 99,
        eventType: EventType.MergeCompleted,
        attempts: 2,
        headSha: "abc123",
        decidingGate: "MERGE",
        outcome: "merged",
        logs: ["squash-merged"],
      },
      () => 5000,
    );

    expect(record.headSha).toBe("abc123");
    expect(record.decidingGate).toBe("MERGE");
    expect(record.eventType).toBe(EventType.MergeCompleted);
    expect(record.attempts).toBe(2);
    expect(record.createdAt).toBe(5000);
  });

  it("writes the record into the eventStream collection", async () => {
    const db = createInMemoryDb();

    const record = await recordEvent(db, {
      runId: "run-7",
      repo: "owner/repo",
      prNumber: 99,
      eventType: EventType.RunStarted,
      attempts: 1,
    });

    const stored = await db.get(Collections.eventStream, record.id);
    expect(stored?.eventType).toBe(EventType.RunStarted);
  });
});

describe("listRunEvents", () => {
  it("returns only the requested run's events, oldest first", async () => {
    const db = createInMemoryDb();
    let clock = 0;
    const tick = () => {
      clock += 100;
      return clock;
    };
    await recordEvent(
      db,
      {
        runId: "run-a",
        repo: "owner/repo",
        prNumber: 1,
        eventType: EventType.StepStarted,
        attempts: 1,
      },
      tick,
    );
    await recordEvent(
      db,
      {
        runId: "run-b",
        repo: "owner/repo",
        prNumber: 2,
        eventType: EventType.StepStarted,
        attempts: 1,
      },
      tick,
    );
    await recordEvent(
      db,
      {
        runId: "run-a",
        repo: "owner/repo",
        prNumber: 1,
        eventType: EventType.StepCompleted,
        attempts: 1,
      },
      tick,
    );

    const events = await listRunEvents(db, "run-a");

    expect(events.map((e) => e.eventType)).toEqual([
      EventType.StepStarted,
      EventType.StepCompleted,
    ]);
  });
});
