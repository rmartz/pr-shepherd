import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StepInstance } from "@/db/schemas";
import type { StepExecutor } from "@/engine/runner";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const DEFAULT_WAIT_AUTHOR_PUSH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WAIT_AUTHOR_PUSH_POLL_INTERVAL_MS = 60 * 1000;

export const WaitAuthorPushInputSchema = z.object({
  pr: z.number().int().nonnegative(),
  sinceReviewSubmittedAt: z.iso.datetime({ offset: true }),
  timeoutMs: z.number().int().nonnegative().optional(),
  pollIntervalMs: z.number().int().nonnegative().optional(),
});
export type WaitAuthorPushInput = z.infer<typeof WaitAuthorPushInputSchema>;

interface CommitSummary {
  sha: string;
  committedDate: string;
}

export interface WaitAuthorPushDependencies {
  listCommitDates?: (pr: number) => Promise<string[]>;
  listCommitSummaries?: (pr: number) => Promise<CommitSummary[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultListCommitDates(pr: number): Promise<string[]> {
  const { stdout } = await execFileAsync("gh", [
    "pr",
    "view",
    String(pr),
    "--json",
    "commits",
    "--jq",
    "[.commits[] | .committedDate]",
  ]);
  return z.array(z.string()).parse(JSON.parse(stdout));
}

async function defaultListCommitSummaries(
  pr: number,
): Promise<CommitSummary[]> {
  const { stdout } = await execFileAsync("gh", [
    "pr",
    "view",
    String(pr),
    "--json",
    "commits",
    "--jq",
    "[.commits[] | {sha: .oid, committedDate: .committedDate}]",
  ]);
  return z
    .array(
      z.object({
        sha: z.string(),
        committedDate: z.string(),
      }),
    )
    .parse(JSON.parse(stdout));
}

function isAfter(inputDate: string, sinceMs: number): boolean {
  const parsed = Date.parse(inputDate);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return parsed > sinceMs;
}

export function createWaitAuthorPushExecutor(
  deps: WaitAuthorPushDependencies = {},
): StepExecutor {
  const listCommitDates = deps.listCommitDates ?? defaultListCommitDates;
  const listCommitSummaries =
    deps.listCommitSummaries ?? defaultListCommitSummaries;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  return async (step: StepInstance) => {
    const input = WaitAuthorPushInputSchema.parse(step.input);
    const startedAt = now();
    const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_AUTHOR_PUSH_TIMEOUT_MS;
    const pollIntervalMs =
      input.pollIntervalMs ?? DEFAULT_WAIT_AUTHOR_PUSH_POLL_INTERVAL_MS;
    const timeoutAt = startedAt + timeoutMs;
    const sinceMs = Date.parse(input.sinceReviewSubmittedAt);

    // Wait steps conceptually transition `running → waiting` and need to
    // refresh `heartbeatAt` once per poll so the heartbeat monitor sees
    // them as live. Under the current `StepExecutor` contract from #56,
    // however, executors only return an `ExecutorResult` — they cannot
    // persist intermediate lifecycle state. The proper plumbing for
    // `enterWaiting()` and `heartbeat()` is tracked in #78; until that
    // contract lands, this poll loop only returns the terminal output
    // and the runner's terminal `Db.update` is the single persistence
    // point.

    for (;;) {
      const committedDates = await listCommitDates(input.pr);
      const hasNewCommit = committedDates.some((d) => isAfter(d, sinceMs));
      const heartbeatAt = now();

      if (hasNewCommit) {
        const summaries = await listCommitSummaries(input.pr);
        const newCommitShas = summaries
          .filter((summary) => isAfter(summary.committedDate, sinceMs))
          .map((summary) => summary.sha);
        return {
          output: {
            pushed: true,
            newCommitShas,
          },
        };
      }

      if (heartbeatAt > timeoutAt) {
        return {
          output: {
            pushed: false,
            reason: "timeout",
          },
        };
      }

      await sleep(pollIntervalMs);
    }
  };
}

export const waitAuthorPushExecutor = createWaitAuthorPushExecutor();
