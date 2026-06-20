import { homedir } from "node:os";
import { spawn as nodeSpawn } from "node:child_process";
import { z } from "zod";
import { Collections } from "@/db/collections";
import { StepStatus, type StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";
import type { StepExecutor, ExecutorResult } from "@/engine/runner/types";

// ---------------------------------------------------------------------------
// `wait_external` step executor.
//
// Wraps ~/.claude/scripts/wait-for-ci.py and
// ~/.claude/scripts/wait-for-copilot-review.py so the engine can wait on
// external state transitions without consuming a global Claude concurrency
// slot (vision §4.3, §6).
//
// Lifecycle inside dispatch:
//   running → waiting  (immediately, freeing the global Claude slot)
//   waiting → completed  (subprocess exits 0: output { passed: true })
//   waiting → failed     (subprocess exits non-zero: output
//                          { passed: false, reason: "timeout" | "error" })
//
// On the runner's cancel signal the subprocess receives SIGTERM; if it has
// not exited within SIGTERM_GRACE_MS milliseconds it receives SIGKILL.
//
// metrics.externalWaitMs records wall-clock time from the moment the step
// entered waiting until the subprocess completed.
//
// The `fix_pr` kind waits on a spawned child / fix PR (created by the `fork`
// executor, #65, whose child run carries the fix PR's number). A fix PR
// "resolves" when its CI run completes, so this kind wraps the same
// wait-for-ci.py script keyed off the fix PR's number — the workflow passes
// that number as `pr` (e.g. from the fork step's child run). This reuses the
// existing subprocess mechanism rather than inventing a new transport; the
// only difference from `ci` is intent and the identifier it keys off.
// ---------------------------------------------------------------------------

// Kept in alphabetical order to minimize merge conflicts. String values match
// the serialized workflow-YAML schema.
export enum WaitExternalKind {
  Ci = "ci",
  CopilotReview = "copilot_review",
  FixPr = "fix_pr",
}

export const WaitExternalInputSchema = z.object({
  kind: z.enum(WaitExternalKind),
  pr: z.number().int().nonnegative(),
  args: z.array(z.string()).optional(),
});
export type WaitExternalInput = z.infer<typeof WaitExternalInputSchema>;

// Exit code convention for wait-*.py scripts:
//   0  = CI / Copilot check passed
//   1  = timed out waiting
//   >1 = unexpected error
function exitReason(code: number | null): "timeout" | "error" {
  return code === 1 ? "timeout" : "error";
}

function scriptPath(kind: WaitExternalKind): string {
  const base = `${homedir()}/.claude/scripts`;
  // `fix_pr` waits on the spawned child/fix PR's CI, so it reuses the CI wait
  // script keyed off the fix PR number.
  if (kind === WaitExternalKind.CopilotReview) {
    return `${base}/wait-for-copilot-review.py`;
  }
  return `${base}/wait-for-ci.py`;
}

// Minimum ChildProcess surface required by the executor.
export interface WaitProcess {
  on(event: "close", listener: (code: number | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  kill(signal: NodeJS.Signals): boolean;
}

export type SpawnFn = (cmd: string, args: string[]) => WaitProcess;
type TimeoutHandle = number | NodeJS.Timeout;

// Grace period between SIGTERM and SIGKILL when a cancel signal fires.
const SIGTERM_GRACE_MS = 5000;

export interface WaitExternalOptions {
  // Injectable subprocess creation; defaults to node:child_process spawn.
  spawn?: SpawnFn;
  // When fired, sends SIGTERM to the subprocess then SIGKILL after the
  // grace period.
  signal?: AbortSignal;
  // Injectable timer for testing the SIGKILL grace period; defaults to
  // the global setTimeout.
  setTimeout?: (fn: () => void, ms: number) => TimeoutHandle;
}

export type WaitExternalResult =
  | { passed: true }
  | { passed: false; reason: "timeout" | "error" };

// ---------------------------------------------------------------------------
// Core: runs the wait subprocess and returns a result. All side effects
// (DB transitions, metrics) live in `createWaitExternalExecutor`; this
// function is kept pure of DB calls so it can be unit-tested directly.
// ---------------------------------------------------------------------------
export async function runWaitExternal(
  input: WaitExternalInput,
  opts: WaitExternalOptions = {},
): Promise<WaitExternalResult> {
  const spawnFn: SpawnFn =
    opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: "ignore" }));
  const setTimeoutFn =
    opts.setTimeout ??
    ((fn: () => void, ms: number): TimeoutHandle => setTimeout(fn, ms));

  const script = scriptPath(input.kind);
  const spawnArgs = [String(input.pr), ...(input.args ?? [])];
  const child = spawnFn(script, spawnArgs);

  return new Promise<WaitExternalResult>((resolve) => {
    let settled = false;
    let sigkillTimer: TimeoutHandle | undefined;

    function settle(result: WaitExternalResult): void {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    }

    function clearSigkillTimer(): void {
      if (sigkillTimer !== undefined) {
        clearTimeout(sigkillTimer);
        sigkillTimer = undefined;
      }
    }

    function killChild(): void {
      if (settled) return;
      child.kill("SIGTERM");
      sigkillTimer = setTimeoutFn(() => {
        if (settled) return;
        child.kill("SIGKILL");
      }, SIGTERM_GRACE_MS);
    }

    const { signal } = opts;
    if (signal !== undefined) {
      if (signal.aborted) {
        killChild();
      } else {
        signal.addEventListener("abort", killChild, { once: true });
      }
    }

    function cleanup(): void {
      clearSigkillTimer();
      if (signal !== undefined) {
        signal.removeEventListener("abort", killChild);
      }
    }

    child.on("close", (code) => {
      cleanup();
      if (code === 0) {
        settle({ passed: true });
      } else {
        settle({ passed: false, reason: exitReason(code) });
      }
    });

    child.on("error", () => {
      cleanup();
      settle({ passed: false, reason: "error" });
    });
  });
}

// ---------------------------------------------------------------------------
// Executor factory. Returns a `StepExecutor` that:
//   1. Transitions the step running → waiting and records waitingAt.
//   2. Invokes `runWaitExternal`.
//   3. Records metrics.externalWaitMs.
//   4. On success: returns { output: { passed: true } } so the runner
//      can transition the step to completed.
//   5. On failure: pre-writes output: { passed: false, reason } then
//      throws so the runner's failStep records the error without
//      overwriting the output we set.
// ---------------------------------------------------------------------------
export function createWaitExternalExecutor(
  db: Db,
  opts: WaitExternalOptions = {},
): StepExecutor {
  return async (step: StepInstance): Promise<ExecutorResult> => {
    const input = WaitExternalInputSchema.parse(step.input);

    const waitingAt = Date.now();
    await db.update(Collections.stepInstances, step.id, {
      status: StepStatus.Waiting,
      waitingAt,
    });

    const result = await runWaitExternal(input, opts);

    const externalWaitMs = Date.now() - waitingAt;
    await db.update(Collections.stepInstances, step.id, {
      metrics: { ...step.metrics, externalWaitMs },
    });

    if (!result.passed) {
      // Pre-populate output before throwing. The runner's failStep only
      // writes status/error/retryCount/completedAt, so this output
      // field persists on the completed step record.
      await db.update(Collections.stepInstances, step.id, {
        output: { passed: false, reason: result.reason },
      });
      throw new Error(result.reason);
    }

    return { output: { passed: true } };
  };
}
