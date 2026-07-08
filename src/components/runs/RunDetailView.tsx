import { StepStatus, type StepInstance } from "@/db/schemas";
import { cn } from "@/lib/utils";
import { formatDurationMs } from "@/lib/format";
import { RUN_DETAIL_COPY } from "./RunDetailView.copy";

// Presentational Run Detail timeline (vision §7.2). Takes a run's steps already
// ordered for the timeline (the store's `selectRunSteps` output) and renders
// one row per step with a status badge, its type, and its duration. Each row is
// a button — the affordance that opens the step drawer (#308) via `onSelectStep`.
// No store/Firestore/hooks, so it is unit-testable and Storybook-safe; the
// `/runs/[id]` page wires the store selector and subscription to it.

const STATUS_BADGE_CLASS: Record<StepStatus, string> = {
  [StepStatus.Cancelled]:
    "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  [StepStatus.Completed]:
    "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
  [StepStatus.Failed]:
    "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  [StepStatus.Pending]:
    "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  [StepStatus.Queued]:
    "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400",
  [StepStatus.Running]:
    "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  [StepStatus.Skipped]:
    "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500",
  [StepStatus.Waiting]:
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
};

// A step's elapsed span once it has finished; `undefined` while in flight.
function stepDurationMs(step: StepInstance): number | undefined {
  return step.completedAt === undefined
    ? undefined
    : step.completedAt - step.createdAt;
}

interface StepStatusBadgeProps {
  status: StepStatus;
}

function StepStatusBadge({ status }: StepStatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_BADGE_CLASS[status],
      )}
    >
      {RUN_DETAIL_COPY.status[status]}
    </span>
  );
}

export interface RunDetailViewProps {
  steps: StepInstance[];
  // Opens the step drawer (#308) for the clicked step. Optional until the drawer
  // lands — the row is still the affordance.
  onSelectStep?: (stepId: string) => void;
}

export function RunDetailView({ steps, onSelectStep }: RunDetailViewProps) {
  return (
    <section className="w-full">
      <h2 className="mb-3 text-lg font-semibold tracking-tight">
        {RUN_DETAIL_COPY.title}
      </h2>
      {steps.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {RUN_DETAIL_COPY.empty}
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {steps.map((step) => {
            const duration = stepDurationMs(step);
            return (
              <li key={step.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelectStep?.(step.id);
                  }}
                  className="flex w-full items-center gap-3 rounded-md border border-zinc-100 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900"
                >
                  <StepStatusBadge status={step.status} />
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {step.stepDefinitionId}
                  </span>
                  <span className="text-zinc-400">{step.stepType}</span>
                  <span className="ml-auto tabular-nums text-zinc-500 dark:text-zinc-400">
                    {duration === undefined
                      ? RUN_DETAIL_COPY.ongoing
                      : formatDurationMs(duration)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
