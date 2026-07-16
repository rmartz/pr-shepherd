import { RunStatus, type WorkflowRun } from "@/db/schemas";
import type { RunListRow } from "@/store";
import { formatDurationMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RUN_LIST_COPY } from "./RunListView.copy";

// Presentational Run List (vision §7.1). Takes pre-derived, pre-ordered rows
// (from the store's `selectRunListRows`) so it stays a pure props→markup
// component: no store, no Firestore, no hooks — trivially unit-testable and
// Storybook-safe. The `/` page wires the store selector to it.

const STATUS_BADGE_CLASS: Record<RunStatus, string> = {
  [RunStatus.Cancelled]:
    "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  [RunStatus.Completed]:
    "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
  [RunStatus.Failed]:
    "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  [RunStatus.Pending]:
    "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  [RunStatus.Running]:
    "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
};

// A run's wall-clock span: creation to completion, or to the last update while
// still in flight.
function wallClockMs(run: WorkflowRun): number {
  return (run.completedAt ?? run.updatedAt) - run.createdAt;
}

interface RunStatusBadgeProps {
  status: RunStatus;
}

function RunStatusBadge({ status }: RunStatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_BADGE_CLASS[status],
      )}
    >
      {RUN_LIST_COPY.status[status]}
    </span>
  );
}

const NUMERIC_CELL =
  "px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400";
const HEADER_CELL =
  "px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400";

export interface RunListViewProps {
  rows: RunListRow[];
}

export function RunListView({ rows }: RunListViewProps) {
  return (
    <section className="w-full">
      <h2 className="mb-3 text-lg font-semibold tracking-tight">
        {RUN_LIST_COPY.title}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {RUN_LIST_COPY.empty}
        </p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th scope="col" className={HEADER_CELL}>
                {RUN_LIST_COPY.columns.run}
              </th>
              <th scope="col" className={HEADER_CELL}>
                {RUN_LIST_COPY.columns.status}
              </th>
              <th scope="col" className={cn(HEADER_CELL, "text-right")}>
                {RUN_LIST_COPY.columns.claude}
              </th>
              <th scope="col" className={cn(HEADER_CELL, "text-right")}>
                {RUN_LIST_COPY.columns.active}
              </th>
              <th scope="col" className={cn(HEADER_CELL, "text-right")}>
                {RUN_LIST_COPY.columns.wallClock}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ run, depth }) => (
              <tr
                key={run.id}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
              >
                <td className="px-3 py-2">
                  <div
                    style={{ paddingLeft: `${(depth * 1.5).toString()}rem` }}
                  >
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">
                      {run.prTitle}
                    </span>
                    <span className="ml-2 text-zinc-400">
                      {run.repo}#{run.prNumber}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <RunStatusBadge status={run.status} />
                </td>
                <td className={NUMERIC_CELL}>
                  {formatDurationMs(run.metrics.totalClaudeMs)}
                </td>
                <td className={NUMERIC_CELL}>
                  {formatDurationMs(run.metrics.totalActiveMs)}
                </td>
                <td className={NUMERIC_CELL}>
                  {formatDurationMs(wallClockMs(run))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
