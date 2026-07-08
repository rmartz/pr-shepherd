import { RunStatus } from "@/db/schemas";

export const RUN_LIST_COPY = {
  title: "Runs",
  empty: "No runs yet.",
  columns: {
    run: "Run",
    status: "Status",
    claude: "Claude",
    active: "Active",
    wallClock: "Wall-clock",
  },
  // User-facing status labels, keyed by the `RunStatus` value on the run.
  status: {
    [RunStatus.Cancelled]: "Cancelled",
    [RunStatus.Completed]: "Completed",
    [RunStatus.Failed]: "Failed",
    [RunStatus.Pending]: "Pending",
    [RunStatus.Running]: "Running",
  },
} as const;
