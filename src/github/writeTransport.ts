import {
  GithubActionType,
  type GithubTransport,
  type GithubTransportResult,
} from "@/steps/githubApi";
import { buildActionCommand } from "./actionCommands";
import {
  defaultGhExec,
  isRateLimitResult,
  type GhExec,
  type GhResult,
} from "./ghExec";

// ---------------------------------------------------------------------------
// Production `GithubTransport` (issue #290) — the write seam `github_api` (#46)
// depends on, backed by the `gh` CLI.
//
// Most actions are one `gh` call (see `buildActionCommand`); `authorize_ci` is
// multi-step (discover the workflow runs awaiting approval for the PR HEAD, then
// approve each). Every `gh` result is mapped to a `GithubTransportResult` the
// executor understands: `rate_limited` (retried with backoff), `error` (retried
// only when transient), or `ok`. The rate-limit check runs first on every path.
// ---------------------------------------------------------------------------

export function createGithubWriteTransport(
  exec: GhExec = defaultGhExec,
): GithubTransport {
  return {
    call: async (action): Promise<GithubTransportResult> => {
      try {
        if (action.type === GithubActionType.AuthorizeCi) {
          return await authorizeCi(action.params, exec);
        }
        return mapResult(await exec(buildActionCommand(action)));
      } catch (err) {
        return {
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
          retriable: false,
        };
      }
    },
  };
}

// Approve the CI runs a PR's HEAD is waiting on: read the HEAD sha, list the
// runs in `action_required`, and approve each. Any failed step short-circuits.
async function authorizeCi(
  params: { repo: string; pr: number },
  exec: GhExec,
): Promise<GithubTransportResult> {
  const head = await exec({
    args: [
      "api",
      `repos/${params.repo}/pulls/${String(params.pr)}`,
      "--jq",
      ".head.sha",
    ],
  });
  const headFailure = terminalFailure(head);
  if (headFailure !== undefined) return headFailure;
  const sha = head.stdout.trim();

  const list = await exec({
    args: [
      "api",
      `repos/${params.repo}/actions/runs?head_sha=${sha}&status=action_required`,
      "--jq",
      ".workflow_runs[].id",
    ],
  });
  const listFailure = terminalFailure(list);
  if (listFailure !== undefined) return listFailure;
  const runIds = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const id of runIds) {
    const approve = await exec({
      args: [
        "api",
        "--method",
        "POST",
        `repos/${params.repo}/actions/runs/${id}/approve`,
      ],
    });
    const approveFailure = terminalFailure(approve);
    if (approveFailure !== undefined) return approveFailure;
  }
  return { kind: "ok", data: { approvedRunIds: runIds } };
}

function mapResult(result: GhResult): GithubTransportResult {
  const failure = terminalFailure(result);
  if (failure !== undefined) return failure;
  return { kind: "ok", data: parseData(result.stdout) };
}

// A `rate_limited` / `error` result for a failed `gh` call, or `undefined` when
// the call succeeded (exit 0). Shared by the single-call path and every step of
// `authorize_ci`.
function terminalFailure(result: GhResult): GithubTransportResult | undefined {
  if (isRateLimitResult(result)) return { kind: "rate_limited" };
  if (result.exitCode !== 0) {
    return {
      kind: "error",
      message: result.stderr.trim() || `gh exited ${String(result.exitCode)}`,
      retriable: isRetriable(result.stderr),
    };
  }
  return undefined;
}

// Transient failures worth retrying: 5xx, network, and timeout signatures. A
// 4xx (bad request / not found / permission / conflict) is not retriable — it
// will fail identically on a retry.
const RETRIABLE_PATTERNS: readonly RegExp[] = [
  /\b5\d\d\b/,
  /timeout/i,
  /timed out/i,
  /connection/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /EAI_AGAIN/,
  /temporarily/i,
];

function isRetriable(stderr: string): boolean {
  return RETRIABLE_PATTERNS.some((pattern) => pattern.test(stderr));
}

function parseData(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (trimmed === "") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw: trimmed };
  }
}
