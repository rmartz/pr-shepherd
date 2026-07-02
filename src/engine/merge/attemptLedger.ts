// ---------------------------------------------------------------------------
// Durable merge-attempt ledger (issue #252, port of POC #1394 / #1396).
//
// A merge that fails for a transient reason must be retried a bounded number of
// times, then escalated — and that count must survive a daemon restart. We
// persist each failed attempt as a hidden HTML-comment marker on the PR, so the
// PR itself is the durable store (no separate database of merge attempts).
//
// This module is the PURE core: it builds and parses the markers and computes
// the current attempt count for a HEAD. The GitHub I/O that posts a marker and
// reads the comment stream is injected into the merge coordinator (mirroring its
// existing `revalidate` / `merge` / `markForFix` seams), so this stays testable
// with no network.
//
// The count is keyed by HEAD SHA, which gives two of the three reset signals for
// free:
//   - a new commit → a new SHA → zero prior markers for it (reset on push);
//   - `escalationClearedAt` discounts markers posted before a human last removed
//     the `escalation needed` label (reset on a server-side fix with no push).
// ---------------------------------------------------------------------------

// The number of transient failures (against one HEAD) that trips escalation. At
// the threshold the coordinator applies sticky `escalation needed` and stops
// retrying; below it, it records a marker and defers to the next cycle.
export const ESCALATION_THRESHOLD = 3;

// One recorded merge attempt, parsed from its marker comment.
export interface AttemptMarker {
  headSha: string;
  // When the marker was written (ms epoch) — used to discount markers older
  // than the most recent `escalation needed` clear.
  at: number;
}

const MARKER_PREFIX = "<!-- pr-shepherd:merge-attempt";
const MARKER_PATTERN = /<!-- pr-shepherd:merge-attempt sha=(\S+) at=(\d+) -->/;

// Build the hidden marker comment body for a failed attempt against `headSha`.
export function buildAttemptMarker(headSha: string, at: number): string {
  return `${MARKER_PREFIX} sha=${headSha} at=${String(at)} -->`;
}

// Parse a comment body into an `AttemptMarker`, or `undefined` when the body is
// not a merge-attempt marker (the common case for ordinary PR comments).
export function parseAttemptMarker(body: string): AttemptMarker | undefined {
  const match = MARKER_PATTERN.exec(body);
  if (match === null) {
    return undefined;
  }
  const [, headSha, at] = match;
  if (headSha === undefined || at === undefined) {
    return undefined;
  }
  return { headSha, at: Number(at) };
}

// Count the attempts recorded against `headSha` that still count toward the
// budget: markers for a different HEAD are ignored (reset on new SHA), and
// markers written at or before `escalationClearedAt` are discounted (reset when
// a human cleared `escalation needed` without a push). `escalationClearedAt`
// defaults to 0 so every same-SHA marker counts when there was no clear.
export function countAttempts(
  markers: readonly AttemptMarker[],
  headSha: string,
  escalationClearedAt = 0,
): number {
  return markers.filter(
    (marker) => marker.headSha === headSha && marker.at > escalationClearedAt,
  ).length;
}
