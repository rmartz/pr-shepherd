import { StepStatus } from "@/db/schemas";

export const RUN_DETAIL_COPY = {
  title: "Steps",
  empty: "No steps yet.",
  // Shown in place of a duration for a step that has not finished.
  ongoing: "—",
  // User-facing step-status labels, keyed by the `StepStatus` value.
  status: {
    [StepStatus.Cancelled]: "Cancelled",
    [StepStatus.Completed]: "Completed",
    [StepStatus.Failed]: "Failed",
    [StepStatus.Pending]: "Pending",
    [StepStatus.Queued]: "Queued",
    [StepStatus.Running]: "Running",
    [StepStatus.Skipped]: "Skipped",
    [StepStatus.Waiting]: "Waiting",
  },
} as const;
