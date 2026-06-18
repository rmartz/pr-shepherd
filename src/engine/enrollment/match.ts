import type { RepositoryConfig } from "@/config";

// ---------------------------------------------------------------------------
// workflowMap matching (vision §9, issue #126).
//
// Each watched repository carries an ordered list of `{ match, workflowId }`
// entries. `matchWorkflowId` resolves a PR author to the first matching
// `workflowId`: entries are evaluated top-to-bottom and the first whose
// `match` pattern matches the author wins (vision §9 "first match wins"). A
// PR matching no entry returns `undefined` and is skipped by the caller.
//
// `match` is a glob over the GitHub login (config.example.yaml):
// `dependabot[bot]` matches that exact login, `*` is the catch-all that
// should be listed last. Only `*` is treated as a wildcard (matching any run
// of characters, including none); every other character — including the `[`
// and `]` in bot logins — is matched literally, so `dependabot[bot]` behaves
// as an exact-login rule rather than a regex character class.
// ---------------------------------------------------------------------------

export function matchWorkflowId(
  author: string,
  workflows: RepositoryConfig["workflows"],
): string | undefined {
  for (const entry of workflows) {
    if (matchesPattern(author, entry.match)) return entry.workflowId;
  }
  return undefined;
}

// Glob match where only `*` is special (matches any run of characters,
// including the empty string). All other characters are matched literally, so
// regex metacharacters in a login (`[`, `]`, `.`, etc.) are escaped before the
// wildcards are substituted back in.
function matchesPattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`);
  return regex.test(value);
}
