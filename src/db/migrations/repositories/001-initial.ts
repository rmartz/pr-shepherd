import type { Migration } from "../index";

// Version 1 is the baseline — documents created on or after this
// migration already conform to the current `RepositorySchema`, so no
// data transformation is required. The migration exists to stamp
// `_meta/repositories` at version 1 so future migrations have a
// meaningful starting point to compare against.
export const initial: Migration = {
  version: 1,
  up: async () => {
    // Baseline migration — no transformation required.
    await Promise.resolve();
  },
};
