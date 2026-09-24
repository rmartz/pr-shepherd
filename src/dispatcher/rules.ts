// ---------------------------------------------------------------------------
// Label → skill dispatch rules (issue #413).
//
// The dispatcher owns no routing logic: pr-lifecycle / merge-safety already
// reduce each PR's state to a label, so a rule is just "PRs matching this
// search get this skill". Rules are listed in PRIORITY order — a PR matching
// several searches (e.g. `approved` + `merge conflict`) is dispatched for the
// first rule only, so the conflict is fixed before a merge is attempted.
// ---------------------------------------------------------------------------

export type DispatchSkill = "/fix-review" | "/merge" | "/review";

export interface DispatchRule {
  // Short identifier used in logs and the `--rule` filter.
  name: string;
  skill: DispatchSkill;
  // Label qualifiers appended to the shared base query.
  filter: string;
  // Run at most one job for this rule per repo at a time (e.g. merges land
  // one by one, so each re-validates against the previous merge).
  serialPerRepo?: boolean;
}

export const DISPATCH_RULES: readonly DispatchRule[] = [
  {
    name: "merge-conflict",
    skill: "/fix-review",
    filter: 'label:"merge conflict" -label:"escalation needed"',
  },
  {
    // pr-lifecycle's static-problem label (conflict and/or failing CI).
    name: "fix-required",
    skill: "/fix-review",
    filter: 'label:"fix required" -label:"blocked" -label:"escalation needed"',
  },
  {
    name: "changes-requested",
    skill: "/fix-review",
    filter:
      'label:"changes requested" -label:"blocked" -label:"escalation needed"',
  },
  {
    name: "review-requested",
    skill: "/review",
    filter:
      'label:"review requested" -label:"blocked" -label:"escalation needed"',
  },
  {
    name: "approved",
    skill: "/merge",
    filter:
      'label:"approved" -label:"blocked" -label:"do not merge" -label:"escalation needed"',
    serialPerRepo: true,
  },
];

const BASE_QUERY = "is:pr involves:@me state:open archived:false draft:false";

// Build the GitHub search query for a rule, optionally narrowed to repos owned
// by `owner` (a user or org login).
export function buildSearchQuery(rule: DispatchRule, owner?: string): string {
  const ownerQualifier = owner ? ` user:${owner}` : "";
  return `${BASE_QUERY}${ownerQualifier} ${rule.filter} sort:updated-asc`;
}
