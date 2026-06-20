import { Collections } from "@/db/collections";
import type { StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";
import {
  createSnapshotCache,
  derivePrState,
  fetchPrSnapshot,
  type DeriveContext,
  type GithubReadTransport,
  type PrSnapshotTarget,
  type PrStateVector,
  type SnapshotCache,
} from "@/engine/derivation";
import type { ExecutorResult, StepExecutor } from "@/engine/runner";

// ---------------------------------------------------------------------------
// `derive_pr_state` step executor (Epic 10, #97).
//
// The step that replaces the vision's `pr-delegate.py` triage placeholder.
// It fetches one rate-limited PR snapshot (#95) for the run's PR, derives the
// flat 8-axis `PrStateVector` (#96), and returns it as `{ state }`. The runner
// merges step output into `workflowRun.context`, so the vector becomes readable
// at `context.state` — which is exactly what the routing DSL (#57) and the gate
// step branch on (`context.state.ci == "passed"`, etc.).
//
// Capability isolation (vision §4.3): this executor is READ-ONLY. It holds a
// `GithubReadTransport` whose only operations are `graphql` and `restPaginate`;
// it never performs a GitHub mutation. All mutation goes through the separate
// `github_api` queue (#46). Both step types draw from the shared GitHub-API
// concurrency budget (#45) — `derive_pr_state` is registered against the
// per-repo and `systemGithubApi` dimensions in `concurrency.ts` / `loop.ts`
// because it performs a GitHub read.
//
// The transport, snapshot cache, and derivation context are injected so tests
// drive the executor without real HTTP, mirroring the snapshot fetcher's
// injected `GithubReadTransport` seam.
// ---------------------------------------------------------------------------

export interface DerivePrStateOutput {
  state: PrStateVector;
}

export interface DerivePrStateDependencies {
  // The injected GitHub read seam. Production wires a real `gh`/Octokit
  // transport; tests inject a fake that returns scripted snapshot data.
  transport: GithubReadTransport;
  // Used to read the run (`repo`, `prNumber`) that the step belongs to.
  db: Db;
  // Optional shared TTL cache so concurrent/repeat derivations of the same PR
  // share a single underlying fetch. Defaults to a per-executor cache.
  cache?: SnapshotCache;
  // Optional pure context for the derivation — e.g. which `blocked on #N`
  // issues are currently open. Defaults to `{}`.
  deriveContext?: DeriveContext;
}

// Split a `"owner/repo"` run field into the snapshot target's owner + repo.
// A run's `repo` is always `owner/name`; anything else is a data error the
// caller should see rather than silently deriving against a malformed target.
function parseTarget(repo: string, prNumber: number): PrSnapshotTarget {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) {
    throw new Error(
      `derive_pr_state expected repo in "owner/name" form; got "${repo}"`,
    );
  }
  return {
    owner: repo.slice(0, slash),
    repo: repo.slice(slash + 1),
    prNumber,
  };
}

export function createDerivePrStateExecutor(
  deps: DerivePrStateDependencies,
): StepExecutor {
  const cache = deps.cache ?? createSnapshotCache();
  const deriveContext = deps.deriveContext ?? {};

  return async (step: StepInstance): Promise<ExecutorResult> => {
    const run = await deps.db.get(Collections.workflowRuns, step.runId);
    if (run === undefined) {
      throw new Error(
        `derive_pr_state step ${step.id} references runId ${step.runId} which does not exist`,
      );
    }

    const target = parseTarget(run.repo, run.prNumber);
    const snapshot = await fetchPrSnapshot(deps.transport, target, { cache });
    const state = derivePrState(snapshot, deriveContext);

    return { output: { state } };
  };
}
