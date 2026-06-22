import { Collections } from "../../collections";
import type { Migration } from "../index";

// Version 2 backfills the `paused` hold flag added in #121. Runs created
// before that field existed have no `paused` key; the scheduler treats a
// missing flag as "not paused", but stamping an explicit `false` keeps the
// stored shape uniform so the UI never has to special-case the absent value.
export const backfillPaused: Migration = {
  version: 2,
  up: async (db) => {
    const runs = await db.list(Collections.workflowRuns);
    for (const run of runs) {
      if (run.paused === undefined) {
        await db.update(Collections.workflowRuns, run.id, { paused: false });
      }
    }
  },
};
