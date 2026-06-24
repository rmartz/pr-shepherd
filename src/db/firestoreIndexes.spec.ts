import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Collections } from "./collections";

// ---------------------------------------------------------------------------
// Declaration test for the Firestore composite indexes (issue #167).
//
// Firestore requires a composite index for any query that filters multiple
// fields with equality. The run-enrollment dedupe lookup `findActiveRun`
// (`src/engine/enrollment/enroll.ts`) queries `workflowRuns` on
// `repo + prNumber + workflowId` and then narrows by run status. This test
// pins the supporting composite index — `(repo, prNumber, workflowId,
// status)` — into `firestore.indexes.json` so the query stays index-backed as
// run volume grows and the in-memory status scan can be pushed into the query.
// ---------------------------------------------------------------------------

interface CompositeIndexField {
  fieldPath: string;
  order?: string;
  arrayConfig?: string;
}

interface CompositeIndex {
  collectionGroup: string;
  queryScope: string;
  fields: CompositeIndexField[];
}

interface FirestoreIndexesFile {
  indexes: CompositeIndex[];
  fieldOverrides: unknown[];
}

const here = dirname(fileURLToPath(import.meta.url));
const INDEXES_PATH = join(here, "..", "..", "firestore.indexes.json");
const indexesFile = JSON.parse(
  readFileSync(INDEXES_PATH, "utf8"),
) as FirestoreIndexesFile;

const FIND_ACTIVE_RUN_FIELDS = ["repo", "prNumber", "workflowId", "status"];

function findActiveRunIndex(): CompositeIndex | undefined {
  return indexesFile.indexes.find(
    (index) =>
      index.collectionGroup === Collections.workflowRuns.name &&
      index.fields.length === FIND_ACTIVE_RUN_FIELDS.length &&
      index.fields.every(
        (field, i) => field.fieldPath === FIND_ACTIVE_RUN_FIELDS[i],
      ),
  );
}

describe("firestore.indexes.json declares the findActiveRun composite index", () => {
  it("indexes the workflowRuns dedupe key (repo, prNumber, workflowId, status)", () => {
    const index = findActiveRunIndex();
    expect(index).toBeDefined();
    expect(index?.fields.map((f) => f.fieldPath)).toEqual(
      FIND_ACTIVE_RUN_FIELDS,
    );
  });

  it("scopes the index to a single collection with all fields ascending", () => {
    const index = findActiveRunIndex();
    expect(index?.queryScope).toBe("COLLECTION");
    expect(index?.fields.map((f) => f.order)).toEqual(
      FIND_ACTIVE_RUN_FIELDS.map(() => "ASCENDING"),
    );
  });
});
