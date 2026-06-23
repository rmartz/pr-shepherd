import { describe, expect, it } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { EventType, type Db } from "@/db";
import {
  makeEventRecord,
  makeWorkflowRun,
} from "./observability-tests/fixtures";
import { analyzeAllRuns, analyzeRuns, type IssueFiler } from "./analysis";
import { AnomalyKind, type Anomaly } from "./anomalies";

function recordingFiler(): { filer: IssueFiler; filed: Anomaly[] } {
  const filed: Anomaly[] = [];
  return {
    filed,
    filer: {
      file: async (anomaly) => {
        filed.push(anomaly);
        await Promise.resolve();
      },
    },
  };
}

async function seedMergeFailure(db: Db, runId: string): Promise<void> {
  await db.create(
    Collections.eventStream,
    makeEventRecord({
      id: `${runId}-mf`,
      runId,
      eventType: EventType.MergeFailed,
      headSha: "sha-1",
    }),
  );
}

describe("analyzeRuns", () => {
  it("files an issue for a detected merge failure", async () => {
    const db = createInMemoryDb();
    const run = makeWorkflowRun({ id: "run-1" });
    await seedMergeFailure(db, "run-1");
    const { filer, filed } = recordingFiler();

    const result = await analyzeRuns(db, [run], filer);

    expect(result.anomalies.map((a) => a.kind)).toContain(
      AnomalyKind.MergeFailure,
    );
    expect(filed).toHaveLength(result.anomalies.length);
  });

  it("dedupes repeat detections of the same anomaly", async () => {
    const db = createInMemoryDb();
    const run = makeWorkflowRun({ id: "run-1", completedAt: undefined });
    // Two merge-failure events at the same SHA collapse to one anomaly.
    await db.create(
      Collections.eventStream,
      makeEventRecord({
        id: "mf-a",
        runId: "run-1",
        eventType: EventType.MergeFailed,
        headSha: "same-sha",
      }),
    );
    await db.create(
      Collections.eventStream,
      makeEventRecord({
        id: "mf-b",
        runId: "run-1",
        eventType: EventType.MergeFailed,
        headSha: "same-sha",
      }),
    );
    const { filer } = recordingFiler();

    const result = await analyzeRuns(db, [run], filer);

    const mergeFailures = result.anomalies.filter(
      (a) => a.kind === AnomalyKind.MergeFailure,
    );
    expect(mergeFailures).toHaveLength(1);
  });
});

describe("analyzeAllRuns", () => {
  it("analyzes every run in the store", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-1" }));
    await seedMergeFailure(db, "run-1");
    const { filer, filed } = recordingFiler();

    await analyzeAllRuns(db, filer);

    expect(filed.map((a) => a.kind)).toContain(AnomalyKind.MergeFailure);
  });
});
