import type { Migration } from "../index";

// Version 1 is the baseline for the `commands` collection (#121) — the
// operator → daemon control plane. Documents are written by the UI already
// conforming to `CommandSchema`, so no data transformation is required. The
// migration exists to stamp `_meta/commands` at version 1 so future
// migrations have a meaningful starting point to compare against.
export const initial: Migration = {
  version: 1,
  up: async () => {
    // Baseline migration — no transformation required.
    await Promise.resolve();
  },
};
