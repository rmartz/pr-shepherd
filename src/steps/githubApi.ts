import type { StepInstance } from "@/db/schemas";
import type { ExecutorResult, StepExecutor } from "@/engine/runner";
import {
  GithubActionType,
  GithubApiInputSchema,
  type GithubAction,
  type GithubApiInput,
} from "./githubApi.schemas";

// ---------------------------------------------------------------------------
// `github_api` step executor.
//
// A single `github_api` step receives a batch of GitHub actions from the
// preceding `claude_skill` step's structured output (vision §4.3) and
// runs them serially through an injected transport. The batch occupies
// exactly one slot in the global GitHub-API concurrency budget (#45)
// from the scheduler's perspective for the duration of the executor's
// run, which is the property that prevents the multi-PR 429 storms the
// daemon was designed to avoid.
//
// Per-action behavior:
//   - 429 / secondary-rate-limit responses are retried with exponential
//     backoff capped at 60s, up to `maxRetries` attempts (default 3).
//   - Non-rate-limit failures are recorded in the per-action result and
//     the batch continues; this is the "partial failure" path. The
//     routing DSL (#57) inspects `output.partial_failure` and
//     `output.results[i]` to decide whether the workflow continues.
//
// The capability-based isolation that bans `claude_skill` steps from
// calling GitHub directly (vision §4.3) is the responsibility of the
// `claude_skill` executor (#61) — it spawns the claude subprocess with
// `GITHUB_TOKEN` / `GH_TOKEN` redacted from the environment. This
// executor is the only path that holds those credentials at runtime.
// ---------------------------------------------------------------------------

// Re-export schema types so external consumers keep their existing import path.
export {
  GithubActionType,
  GithubActionSchema,
  GithubApiInputSchema,
  type GithubAction,
  type GithubApiInput,
} from "./githubApi.schemas";

// --- Transport abstraction -------------------------------------------------

// The transport is the indirection that lets the executor be unit-tested
// without spawning real `gh` subprocesses. Production callers wire the
// real `gh`-CLI / GitHub-MCP transport; tests inject a fake one that
// returns scripted responses including rate-limit hits.

export type GithubTransportResult =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "rate_limited" }
  | { kind: "error"; message: string; retriable: boolean };

export interface GithubTransport {
  call(action: GithubAction): Promise<GithubTransportResult>;
}

// --- Result types ----------------------------------------------------------

export type GithubActionOutcome = "ok" | "failed" | "rate_limited";

export interface GithubActionResult {
  index: number;
  actionType: GithubActionType;
  outcome: GithubActionOutcome;
  data?: Record<string, unknown>;
  error?: string;
  attempts: number;
}

export interface GithubApiOutput {
  results: GithubActionResult[];
  partial_failure: boolean;
}

// --- Executor --------------------------------------------------------------

export interface RunGithubApiOptions {
  transport: GithubTransport;
  // Injectable sleep for tests; defaults to setTimeout in production.
  sleep?: (ms: number) => Promise<void>;
  // Initial backoff for the first 429 retry; doubles each attempt up to
  // `maxBackoffMs`.
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  // Max retries on rate-limit responses before giving up on one action.
  maxRetries?: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 60000;
const DEFAULT_MAX_RETRIES = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runGithubApi(
  input: GithubApiInput,
  opts: RunGithubApiOptions,
): Promise<GithubApiOutput> {
  const sleep = opts.sleep ?? defaultSleep;
  const initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  const results: GithubActionResult[] = [];
  let partialFailure = false;

  for (const [i, action] of input.actions.entries()) {
    const result = await runOneAction(action, i, opts.transport, sleep, {
      initialBackoffMs,
      maxBackoffMs,
      maxRetries,
    });
    results.push(result);
    if (result.outcome !== "ok") {
      partialFailure = true;
    }
  }

  return { results, partial_failure: partialFailure };
}

// The `StepExecutor` adapter the runner registers for `StepType.GithubApi`.
// Parses the step's action batch, runs it through `runGithubApi` against the
// injected transport, and returns the per-action results + partial-failure flag
// as the step output (which the routing DSL can branch on). The production
// daemon constructs this with the `gh`-CLI write transport (#290).
export function createGithubApiExecutor(
  opts: RunGithubApiOptions,
): StepExecutor {
  return async (step: StepInstance): Promise<ExecutorResult> => {
    const input = GithubApiInputSchema.parse(step.input);
    const { results, partial_failure } = await runGithubApi(input, opts);
    return { output: { results, partial_failure } };
  };
}

interface RetryConfig {
  initialBackoffMs: number;
  maxBackoffMs: number;
  maxRetries: number;
}

async function runOneAction(
  action: GithubAction,
  index: number,
  transport: GithubTransport,
  sleep: (ms: number) => Promise<void>,
  retry: RetryConfig,
): Promise<GithubActionResult> {
  // Guard: a `rebase_dependabot` action no-ops when a rebase is already in
  // progress. The marker ("Dependabot is rebasing this PR") is authoritative
  // and current, so posting another `@dependabot rebase` would be a redundant
  // command. We short-circuit to `ok` WITHOUT touching the transport — no
  // GitHub mutation happens — and flag `skipped` so downstream routing can
  // tell the rebase was guarded rather than newly requested.
  if (
    action.type === GithubActionType.RebaseDependabot &&
    action.params.rebaseInProgress
  ) {
    return {
      index,
      actionType: action.type,
      outcome: "ok",
      data: { skipped: true, reason: "rebase already in progress" },
      attempts: 0,
    };
  }

  let attempts = 0;
  let lastError: string | undefined;

  while (attempts <= retry.maxRetries) {
    attempts++;
    const response = await transport.call(action);

    switch (response.kind) {
      case "ok":
        return {
          index,
          actionType: action.type,
          outcome: "ok",
          data: response.data,
          attempts,
        };

      case "rate_limited":
        if (attempts > retry.maxRetries) {
          return {
            index,
            actionType: action.type,
            outcome: "rate_limited",
            error: `gave up after ${String(attempts)} attempts (rate limit)`,
            attempts,
          };
        }
        await sleep(backoffFor(attempts, retry));
        continue;

      case "error":
        if (response.retriable && attempts <= retry.maxRetries) {
          lastError = response.message;
          await sleep(backoffFor(attempts, retry));
          continue;
        }
        return {
          index,
          actionType: action.type,
          outcome: "failed",
          error: response.message,
          attempts,
        };
    }
  }

  // Fall-through when the loop exits without returning — only reachable
  // if a retriable error exhausted retries.
  return {
    index,
    actionType: action.type,
    outcome: "failed",
    error: lastError ?? "exhausted retries",
    attempts,
  };
}

function backoffFor(attempt: number, retry: RetryConfig): number {
  // Exponential: initial * 2^(attempt-1); capped at max.
  const ms = retry.initialBackoffMs * Math.pow(2, attempt - 1);
  return Math.min(ms, retry.maxBackoffMs);
}
