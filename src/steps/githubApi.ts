import { z } from "zod";

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

// --- Action types ----------------------------------------------------------

// Kept in alphabetical order to minimize merge conflicts.
export enum GithubActionType {
  AddLabel = "add_label",
  AuthorizeCi = "authorize_ci",
  PostComment = "post_comment",
  PostInlineComment = "post_inline_comment",
  PostReview = "post_review",
  RebaseDependabot = "rebase_dependabot",
  RemoveLabel = "remove_label",
  RequestSquashMerge = "request_squash_merge",
  ResolveThread = "resolve_thread",
  UpdateBranch = "update_branch",
}

// Per-action Zod schemas. The closed enum on `type` is the contract:
// unknown action types fail to parse at workflow-load time so the
// workflow loader (#47) catches them before any execution.

const RepoPrParams = z.object({
  repo: z.string().min(1),
  pr: z.number().int().nonnegative(),
});

const AddLabelSchema = z.object({
  type: z.literal(GithubActionType.AddLabel),
  params: RepoPrParams.extend({ label: z.string().min(1) }),
});

const AuthorizeCiSchema = z.object({
  type: z.literal(GithubActionType.AuthorizeCi),
  params: RepoPrParams,
});

const PostCommentSchema = z.object({
  type: z.literal(GithubActionType.PostComment),
  params: RepoPrParams.extend({ body: z.string() }),
});

const PostInlineCommentSchema = z.object({
  type: z.literal(GithubActionType.PostInlineComment),
  params: RepoPrParams.extend({
    file: z.string(),
    line: z.number().int().nonnegative(),
    body: z.string(),
    // The HEAD commit SHA the inline comment anchors to. The REST API
    // (`POST .../pulls/{n}/comments`) requires `commit_id`, and the review
    // skill that emits this action already knows the PR's HEAD — so it supplies
    // it here rather than making the write transport re-fetch it (#290).
    commitId: z.string().min(1),
  }),
});

const PostReviewSchema = z.object({
  type: z.literal(GithubActionType.PostReview),
  params: RepoPrParams.extend({
    verdict: z.enum(["approved", "changes_requested", "commented"]),
    body: z.string(),
  }),
});

// Posts `@dependabot rebase`. `rebaseInProgress` carries the derived rebase
// marker (`context.state.dependabotRebase === "in_progress"`) so the guard
// rides along with the action — `post_comment` would strip it. When true, the
// executor no-ops instead of posting a redundant command while a rebase is
// already running (the marker is authoritative and current). Defaults to
// false so an action authored without the guard still posts.
const RebaseDependabotSchema = z.object({
  type: z.literal(GithubActionType.RebaseDependabot),
  params: RepoPrParams.extend({
    rebaseInProgress: z.boolean().default(false),
  }),
});

const RemoveLabelSchema = z.object({
  type: z.literal(GithubActionType.RemoveLabel),
  params: RepoPrParams.extend({ label: z.string().min(1) }),
});

const RequestSquashMergeSchema = z.object({
  type: z.literal(GithubActionType.RequestSquashMerge),
  params: RepoPrParams,
});

const ResolveThreadSchema = z.object({
  type: z.literal(GithubActionType.ResolveThread),
  params: z.object({ threadId: z.string().min(1) }),
});

const UpdateBranchSchema = z.object({
  type: z.literal(GithubActionType.UpdateBranch),
  params: RepoPrParams,
});

export const GithubActionSchema = z.discriminatedUnion("type", [
  AddLabelSchema,
  AuthorizeCiSchema,
  PostCommentSchema,
  PostInlineCommentSchema,
  PostReviewSchema,
  RebaseDependabotSchema,
  RemoveLabelSchema,
  RequestSquashMergeSchema,
  ResolveThreadSchema,
  UpdateBranchSchema,
]);
export type GithubAction = z.infer<typeof GithubActionSchema>;

export const GithubApiInputSchema = z.object({
  actions: z.array(GithubActionSchema),
});
export type GithubApiInput = z.infer<typeof GithubApiInputSchema>;

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
