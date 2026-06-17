import type { Config } from "@/config";
import type {
  DiscoveredPr,
  DiscoveryError,
  DiscoverySweep,
  PrReadTransport,
} from "./types";

// ---------------------------------------------------------------------------
// `discoverOpenPrs` — the single-pass sweep that lists open PRs for every
// enabled repository in the daemon `Config` (issue #125).
//
//   - Disabled repos (`enabled === false`) are skipped — the transport is
//     never queried for them.
//   - The sweep is fail-open: a per-repo transport rejection does not abort
//     the pass. The repo's error is recorded in `errors` and the remaining
//     repos are still swept, so one repo failing never starves the others.
//
// The returned `DiscoverySweep` is what the long-running loop hands to
// enrollment (a separate sub-issue). Repos are swept sequentially so a slow or
// rate-limited repo does not fan out concurrent reads against the shared
// GitHub budget; the per-tick cost is bounded by the enabled-repo count.
// ---------------------------------------------------------------------------

export async function discoverOpenPrs(
  config: Config,
  transport: PrReadTransport,
): Promise<DiscoverySweep> {
  const discovered: DiscoveredPr[] = [];
  const errors: DiscoveryError[] = [];

  for (const repo of config.repositories) {
    if (!repo.enabled) continue;
    try {
      const prs = await transport.listOpenPrs(repo.id);
      discovered.push(...prs);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push({ repo: repo.id, message });
    }
  }

  return { discovered, errors };
}
