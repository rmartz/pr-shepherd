// ---------------------------------------------------------------------------
// Merge-error classification (issue #252, port of POC #1393 error_classification).
//
// A merge attempt can fail two fundamentally different ways:
//   - operator-actionable — the token lacks a scope/permission, credentials are
//     bad, or an SSO authorization is required. These can NEVER succeed on a
//     retry; a human must act. The merge path escalates them immediately rather
//     than spending the retry budget on attempts that are guaranteed to fail.
//   - transient — a rate-limit blip, a mergeability race, or persistent
//     branch-protection that may clear on its own. These are counted against the
//     durable per-(PR, head SHA) retry budget and retried until the threshold.
//
// The classifier is pure (message string in → class out) so it is trivially
// testable and carries no I/O.
// ---------------------------------------------------------------------------

// The two failure classes. A structural union (not an enum): it never crosses a
// serialization boundary, but it is a tiny fixed set read only in-process, and
// the union keeps raw literals assignable without a cast.
export type MergeErrorClass = "operator_actionable" | "transient";

// Patterns that mark a failure operator-actionable. Kept deliberately narrow —
// only the four documented can-never-succeed causes (missing `workflow` scope,
// bad credentials, missing permissions, unauthorized SSO). Anything unmatched
// is treated as transient and retried, so a false negative merely costs retries
// while a false positive would wrongly block a PR a human never needed to touch.
const OPERATOR_ACTIONABLE_PATTERNS: readonly RegExp[] = [
  /bad credentials/i, // expired / invalid token
  /must have .*access/i, // missing repo write/admin permission
  /not authorized/i,
  /refusing to allow .*workflow/i, // token lacks the `workflow` scope
  /resource not accessible/i, // integration lacks the permission
  /\bsaml\b/i, // SSO authorization required
  /\bsso\b/i,
  /workflow.*scope/i,
  /\b401\b/,
  /\b403\b/,
];

export function classifyMergeError(message: string): MergeErrorClass {
  return OPERATOR_ACTIONABLE_PATTERNS.some((pattern) => pattern.test(message))
    ? "operator_actionable"
    : "transient";
}

// Extract a classifiable message from an unknown thrown value. `Error` is the
// common case; anything else is stringified so classification still runs.
export function mergeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
