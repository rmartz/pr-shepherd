import type { IssueCommentSnapshot } from "@/engine/derivation";
import { parseOutcomeMarker } from "./marker";
import { type SkillOutcomeRecord } from "./types";

// ---------------------------------------------------------------------------
// Outcome derivation signals (Epic 11, #151; extends derivation #96).
//
// Pure functions that turn the PR's raw issue comments into the two derived
// signals the harness routes off:
//
//   1. `latestOutcomePerSkill` — the most recent outcome record for each skill
//      (`review`, `merge`, …), so "what did the last run of this step decide"
//      is answerable without any local state.
//   2. `newCommentSinceOutcome` — whether a NON-outcome comment (human or
//      Copilot) landed after a given skill's most recent outcome. A new comment
//      after an `approve` means the approval is stale and the PR must return to
//      review rather than advancing.
//
// Comment ordering is by `createdAt`. GitHub returns issue comments oldest →
// newest, but we sort defensively so the "latest" / "since" comparisons never
// depend on fetch order. A comment with no `createdAt` sorts as oldest (it
// cannot be proven newer than a timestamped one).
// ---------------------------------------------------------------------------

// One parsed outcome paired with the comment timestamp it was posted at, so a
// later "new comment since" comparison can be made without re-parsing.
export interface DerivedOutcome {
  record: SkillOutcomeRecord;
  // ms-epoch of the comment's `createdAt`; `undefined` when GitHub omitted it.
  postedAt: number | undefined;
}

function toEpoch(createdAt: string | undefined): number | undefined {
  if (createdAt === undefined) return undefined;
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? undefined : ms;
}

// Sort key that puts undefined-timestamp comments first (treated as oldest).
function sortKey(createdAt: string | undefined): number {
  return toEpoch(createdAt) ?? Number.NEGATIVE_INFINITY;
}

// The most recent outcome record per skill, keyed by skill name. A skill with
// no outcome comment is simply absent from the map — distinct from a skill
// that posted an `error` outcome.
export function latestOutcomePerSkill(
  comments: IssueCommentSnapshot[],
): Map<string, DerivedOutcome> {
  const sorted = [...comments].sort(
    (a, b) => sortKey(a.createdAt) - sortKey(b.createdAt),
  );
  const latest = new Map<string, DerivedOutcome>();
  for (const comment of sorted) {
    const record = parseOutcomeMarker(comment.body);
    if (record === undefined) continue;
    // Later in sorted order wins — overwrite any earlier outcome for the skill.
    latest.set(record.skill, { record, postedAt: toEpoch(comment.createdAt) });
  }
  return latest;
}

// Whether a non-outcome comment was posted after the given skill's most recent
// outcome. `true` means a human or Copilot commented since the last `skill`
// outcome — the routing layer treats that as "re-evaluate, do not advance on a
// stale verdict". Returns `false` when the skill has no outcome yet (there is
// nothing to be newer than).
//
// A comment that itself carries an outcome marker is NOT counted as a "new
// comment" — outcome comments are the daemon's own records, not external
// signal. Only the SAME skill's outcomes are excluded from the "newer" check;
// the skill argument scopes which outcome anchors the comparison.
export function newCommentSinceOutcome(
  comments: IssueCommentSnapshot[],
  skill: string,
): boolean {
  const latest = latestOutcomePerSkill(comments).get(skill);
  if (latest === undefined) return false;
  const anchor = latest.postedAt ?? Number.NEGATIVE_INFINITY;
  return comments.some((comment) => {
    if (parseOutcomeMarker(comment.body) !== undefined) return false;
    const postedAt = toEpoch(comment.createdAt);
    return postedAt !== undefined && postedAt > anchor;
  });
}
