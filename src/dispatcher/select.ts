import type { DispatchRule } from "./rules";
import type { PrSearchHit } from "./search";

// ---------------------------------------------------------------------------
// Pure job selection for the dispatcher (issue #413).
//
// Labels are maintained asynchronously by pr-lifecycle, so right after a skill
// finishes the PR can still carry the label that triggered it. Two guards stop
// that lag (or a skill that keeps failing) from hot-looping, both keyed on
// `(skill, headSha)` so any new push or routing change resets them:
//   - cooldown: no re-dispatch within `cooldownMs` of the last attempt ending;
//   - stall: no re-dispatch at all after `maxAttempts` attempts.
// ---------------------------------------------------------------------------

export interface DispatchCandidate extends PrSearchHit {
  // `owner/name#number` — the identity used for running/history tracking.
  key: string;
  rule: DispatchRule;
}

export interface AttemptRecord {
  skill: string;
  headSha: string;
  attempts: number;
  lastFinishedAt: number;
}

export type SkipReason = "cooldown" | "running" | "stalled" | "no-slot";

export interface SelectionInput {
  candidates: readonly DispatchCandidate[];
  running: ReadonlySet<string>;
  history: ReadonlyMap<string, AttemptRecord>;
  now: number;
  slots: number;
  cooldownMs: number;
  maxAttempts: number;
}

export interface Selection {
  jobs: DispatchCandidate[];
  skipped: { candidate: DispatchCandidate; reason: SkipReason }[];
}

export function prKey(hit: Pick<PrSearchHit, "repo" | "number">): string {
  return `${hit.repo}#${String(hit.number)}`;
}

// Flatten per-rule search results into one candidate per PR, keeping the
// highest-priority rule. `results` must be in rule-priority order.
export function assignRules(
  results: readonly { rule: DispatchRule; hits: readonly PrSearchHit[] }[],
): DispatchCandidate[] {
  const byKey = new Map<string, DispatchCandidate>();
  for (const { rule, hits } of results) {
    for (const hit of hits) {
      const key = prKey(hit);
      if (!byKey.has(key)) byKey.set(key, { ...hit, key, rule });
    }
  }
  return [...byKey.values()];
}

function blockingReason(
  candidate: DispatchCandidate,
  input: SelectionInput,
): SkipReason | undefined {
  if (input.running.has(candidate.key)) return "running";
  const record = input.history.get(candidate.key);
  if (
    record?.skill !== candidate.rule.skill ||
    record.headSha !== candidate.headSha
  ) {
    return undefined;
  }
  if (record.attempts >= input.maxAttempts) return "stalled";
  if (input.now - record.lastFinishedAt < input.cooldownMs) return "cooldown";
  return undefined;
}

export function selectJobs(input: SelectionInput): Selection {
  const selection: Selection = { jobs: [], skipped: [] };
  for (const candidate of input.candidates) {
    const reason =
      blockingReason(candidate, input) ??
      (selection.jobs.length >= input.slots ? "no-slot" : undefined);
    if (reason) selection.skipped.push({ candidate, reason });
    else selection.jobs.push(candidate);
  }
  return selection;
}

// Record a finished attempt, resetting the count when the skill or head moved.
export function recordAttempt(
  history: Map<string, AttemptRecord>,
  candidate: DispatchCandidate,
  finishedAt: number,
): void {
  const previous = history.get(candidate.key);
  const sameTarget =
    previous?.skill === candidate.rule.skill &&
    previous.headSha === candidate.headSha;
  history.set(candidate.key, {
    skill: candidate.rule.skill,
    headSha: candidate.headSha,
    attempts: sameTarget ? previous.attempts + 1 : 1,
    lastFinishedAt: finishedAt,
  });
}
