import { WebhookEventType, type WebhookEvent } from "@/db/schemas";

// ---------------------------------------------------------------------------
// Event → derivation-target mapping (Epic 12, #112).
//
// A persisted raw webhook delivery (#111) carries, in its payload, the
// PR(s) it affects — but *where* the PR number lives differs per event
// type. This module is the pure translation from one `WebhookEvent` to the
// set of `EventTarget`s it implicates, with **no** I/O: it only reads the
// stored payload. `triggerDerivations` (derivation-trigger.ts) then resolves
// each target against tracked runs and enqueues a `derive_pr_state` cycle.
//
// Two target shapes exist because GitHub payloads name the affected PR two
// different ways:
//
//   - **By number** — most PR-scoped events embed the PR number directly
//     (`pull_request.number`, `issue.number`, `check_suite.pull_requests[]`).
//   - **By branch** — a `push` payload names the pushed `ref` (a branch), not
//     a PR; the affected PR is whichever open PR has that head branch. The
//     trigger resolves branch targets to PR numbers against tracked runs.
//
// Keeping the mapping pure and exhaustive over `WebhookEventType` makes the
// "which PR(s) does this event touch?" decision unit-testable from a raw
// payload, with no Db, transport, or clock.
// ---------------------------------------------------------------------------

// A PR identified directly by its number, extracted from the payload.
export interface PrNumberTarget {
  repo: string;
  prNumber: number;
}

// A PR identified indirectly by the branch a `push` updated. The trigger
// resolves it to concrete PR number(s) by matching tracked runs on the repo
// and head branch.
export interface BranchTarget {
  repo: string;
  branch: string;
}

export type EventTarget = PrNumberTarget | BranchTarget;

// Type guard so the trigger can branch on which resolution path a target needs
// without an `in`-operator check at each call site.
export function isBranchTarget(target: EventTarget): target is BranchTarget {
  return "branch" in target;
}

// Narrow an unknown payload value to a record so nested field reads are typed
// without `any`. Returns `undefined` for non-objects (including arrays/null),
// so a malformed payload yields no targets rather than throwing.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// Read one field off a (possibly-undefined) record. Centralizes the bracket
// access the index-signature lint requires, so every payload read below stays
// dot-free and the optional-chaining is in one place.
function field(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown {
  return record?.[key];
}

// The `owner/repo` slug a delivery concerns, read from the conventional
// `repository.full_name`. Every subscribed event type includes it.
function repoSlug(payload: Record<string, unknown>): string | undefined {
  return asString(field(asRecord(field(payload, "repository")), "full_name"));
}

// Pull the PR number from a `pull_request` (or top-level `number`) payload.
// `pull_request`, `pull_request_review`, and `pull_request_review_thread`
// all nest the PR object under `pull_request`.
function pullRequestTargets(
  repo: string,
  payload: Record<string, unknown>,
): PrNumberTarget[] {
  const pr = asRecord(field(payload, "pull_request"));
  const prNumber =
    asNumber(field(pr, "number")) ?? asNumber(field(payload, "number"));
  return prNumber === undefined ? [] : [{ repo, prNumber }];
}

// `issue_comment` fires for both issues and PRs; only PR comments carry a
// `pull_request` object on the issue. A plain-issue comment touches no PR and
// yields no target (dropped cleanly downstream).
function issueCommentTargets(
  repo: string,
  payload: Record<string, unknown>,
): PrNumberTarget[] {
  const issue = asRecord(field(payload, "issue"));
  if (
    issue === undefined ||
    asRecord(field(issue, "pull_request")) === undefined
  ) {
    return [];
  }
  const prNumber = asNumber(field(issue, "number"));
  return prNumber === undefined ? [] : [{ repo, prNumber }];
}

// `check_run`, `check_suite`, and `status` carry an array of associated PRs
// under `<root>.pull_requests` (check events nest the array inside the
// check object; `status` puts it at the top level). One commit can belong to
// several PRs, so this can yield multiple targets.
function checkTargets(
  repo: string,
  payload: Record<string, unknown>,
  rootKey: string,
): PrNumberTarget[] {
  const root = asRecord(field(payload, rootKey)) ?? payload;
  const prs = field(root, "pull_requests");
  if (!Array.isArray(prs)) return [];
  const targets: PrNumberTarget[] = [];
  for (const entry of prs) {
    const prNumber = asNumber(field(asRecord(entry), "number"));
    if (prNumber !== undefined) targets.push({ repo, prNumber });
  }
  return targets;
}

// A `push` names the updated branch in `ref` (`refs/heads/<branch>`); the
// affected PR is whichever open PR has that head branch, resolved by the
// trigger. Branch deletes (`deleted: true`) and tag pushes touch no PR head.
function pushTargets(
  repo: string,
  payload: Record<string, unknown>,
): BranchTarget[] {
  if (field(payload, "deleted") === true) return [];
  const ref = asString(field(payload, "ref"));
  const prefix = "refs/heads/";
  if (ref?.startsWith(prefix) !== true) return [];
  return [{ repo, branch: ref.slice(prefix.length) }];
}

// Map one raw webhook delivery to the derivation targets it implicates. An
// event whose payload names no PR (a plain-issue comment, a tag push, a
// malformed body) returns `[]` — the caller drops it as a clean no-op.
export function eventToTargets(event: WebhookEvent): EventTarget[] {
  const payload = asRecord(event.payload);
  if (payload === undefined) return [];
  const repo = repoSlug(payload);
  if (repo === undefined) return [];

  switch (event.eventType) {
    case WebhookEventType.CheckRun:
      return checkTargets(repo, payload, "check_run");
    case WebhookEventType.CheckSuite:
      return checkTargets(repo, payload, "check_suite");
    case WebhookEventType.IssueComment:
      return issueCommentTargets(repo, payload);
    case WebhookEventType.PullRequest:
    case WebhookEventType.PullRequestReview:
    case WebhookEventType.PullRequestReviewThread:
      return pullRequestTargets(repo, payload);
    case WebhookEventType.Push:
      return pushTargets(repo, payload);
    case WebhookEventType.Status:
      return checkTargets(repo, payload, "status");
  }
}
