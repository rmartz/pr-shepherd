// ---------------------------------------------------------------------------
// PR-discovery types (vision §4.1 trigger, §13.1 polling). The daemon polls
// each enabled configured repository for open PRs that should be driven, then
// hands the discovered set to enrollment. Webhooks (Epic 12) later replace the
// poll as the primary trigger, keeping this loop as the reconciliation
// fallback. See issue #125.
// ---------------------------------------------------------------------------

// A single open PR discovered during a sweep. The minimal shape enrollment
// needs to identify and route the PR; richer detail is fetched downstream.
export interface DiscoveredPr {
  repo: string;
  number: number;
  author: string;
  title: string;
}

// The read-side transport seam, mirroring the write-side `GithubTransport` in
// `src/steps/githubApi.ts`. Production wires the real `gh`-CLI / GitHub-MCP
// transport; tests inject a fake one that returns scripted responses without
// touching the network. `listOpenPrs` rejects when the underlying read fails
// — the sweep catches per-repo rejections to keep the overall pass fail-open.
export interface PrReadTransport {
  listOpenPrs: (repoId: string) => Promise<DiscoveredPr[]>;
}

// A per-repo discovery failure recorded by the sweep. The sweep does not abort
// when one repo's read fails (fail open); it collects the failure here so the
// caller can surface it without losing the PRs found in healthy repos.
export interface DiscoveryError {
  repo: string;
  message: string;
}

// The result of one discovery sweep: the aggregated open PRs across every
// enabled repo, plus any per-repo errors that were tolerated.
export interface DiscoverySweep {
  discovered: DiscoveredPr[];
  errors: DiscoveryError[];
}
