import type { Migration } from "../index";

// Version 1 baseline — see `repositories/001-initial.ts` for rationale.
export const initial: Migration = {
  version: 1,
  up: async () => {
    await Promise.resolve();
  },
};
