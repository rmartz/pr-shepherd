import type { DeriveContext } from "./state-vector";
import type { PrSnapshot } from "./types";
import { Activity, HoldState } from "./state-vector";

// ---------------------------------------------------------------------------
// Hold + Activity axis derivation (#96).
//
// Hold is the "should the daemon keep its hands off this PR" axis. Drafts and
// `[WIP]` titles hold automatically; `do not merge`/`dnm` labels are explicit
// holds. A `blocked on #N` marker holds ONLY while issue N is open (the open
// set is supplied via context), so the hold auto-resumes the moment the issue
// closes — derivation never needs to be re-armed.
//
// Activity is OBSERVATIONAL ONLY and must never feed `decide()`. It reports
// whether the PR is moving (recent events), idle, or parked waiting on a
// delegate's response.
// ---------------------------------------------------------------------------

const DO_NOT_MERGE_LABELS = new Set(["do not merge", "do-not-merge", "dnm"]);
const ESCALATION_LABELS = new Set(["escalation needed", "escalation-needed"]);
const BLOCKED_ON_ISSUE = /blocked on #(\d+)/i;
const DEFAULT_IDLE_THRESHOLD_MS = 86_400_000; // 24h

function hasLabel(snapshot: PrSnapshot, candidates: Set<string>): boolean {
  return snapshot.labels.some((l) => candidates.has(l.toLowerCase()));
}

// Issue number a `blocked on #N` marker references, if any text (title or a
// comment body) carries it. First match wins.
function blockedOnIssue(snapshot: PrSnapshot): number | undefined {
  const texts = [snapshot.title, ...snapshot.issueComments.map((c) => c.body)];
  for (const text of texts) {
    const match = BLOCKED_ON_ISSUE.exec(text);
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

export function deriveHold(
  snapshot: PrSnapshot,
  context: DeriveContext,
): HoldState {
  if (hasLabel(snapshot, DO_NOT_MERGE_LABELS)) return HoldState.DoNotMerge;
  if (hasLabel(snapshot, ESCALATION_LABELS)) return HoldState.EscalationNeeded;

  const blockingIssue = blockedOnIssue(snapshot);
  if (
    blockingIssue !== undefined &&
    (context.openIssueNumbers ?? []).includes(blockingIssue)
  ) {
    return HoldState.BlockedOnIssue;
  }

  if (snapshot.isDraft) return HoldState.Draft;
  if (/^\s*\[wip\]/i.test(snapshot.title)) return HoldState.Wip;
  return HoldState.None;
}

// The most recent event time across reviews and comments (ms epoch, 0 if none).
function lastEventMs(snapshot: PrSnapshot): number {
  const times = [
    ...snapshot.reviews.map((r) => Date.parse(r.submittedAt ?? "")),
    ...snapshot.issueComments.map((c) => Date.parse(c.createdAt ?? "")),
  ].filter((t) => !Number.isNaN(t));
  return times.length === 0 ? 0 : Math.max(...times);
}

function awaitingDelegate(
  snapshot: PrSnapshot,
  context: DeriveContext,
): boolean {
  const delegates = context.delegateLogins ?? [];
  if (delegates.length === 0) return false;
  const lowered = delegates.map((d) => d.toLowerCase());
  const matchesDelegate = (actor: string | undefined): boolean =>
    actor !== undefined && lowered.some((d) => actor.toLowerCase().includes(d));

  // Waiting iff a delegate is engaged (commented/reviewed) but has not left a
  // terminal verdict that resolves the wait.
  return snapshot.reviews.some(
    (r) =>
      matchesDelegate(r.author) &&
      r.state !== "APPROVED" &&
      r.state !== "CHANGES_REQUESTED",
  );
}

export function deriveActivity(
  snapshot: PrSnapshot,
  context: DeriveContext,
): Activity {
  if (awaitingDelegate(snapshot, context)) return Activity.DelegatedWaiting;

  const now = context.now ?? snapshot.fetchedAt;
  const threshold = context.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const last = lastEventMs(snapshot);
  if (last === 0) return Activity.Idle;
  return now - last <= threshold ? Activity.Active : Activity.Idle;
}
