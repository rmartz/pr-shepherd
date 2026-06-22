import type { Config } from "@/config";
import type { Db } from "@/db/types";
import { discoverOpenPrs } from "@/engine/discovery";
import type { DiscoveryError, PrReadTransport } from "@/engine/discovery";
import {
  enrollDiscovered,
  type EnrolledPr,
  type EnrollmentReport,
  type SkippedPr,
  type WorkflowResolver,
} from "@/engine/enrollment";
import type { EnrollDiscoveredOptions } from "@/engine/enrollment";

// ---------------------------------------------------------------------------
// Self-discovery integration (vision §5, §8; lifecycle design §6; issue #108).
//
// `runSelfDiscoveryPass` is the daemon-facing seam that turns the merged
// discovery (#125) and enrollment (#126) building blocks into one cohesive
// pass: it recomputes the routable PR set from *live* GitHub state each time
// it runs — never from a stored queue — and enrolls newly-eligible PRs into
// `workflowRun`s idempotently.
//
//   discover (live sweep) → match author → resolve workflow → enroll run
//
// **Recomputed, not stored (criterion 1).** Each pass re-reads open PRs via
// the injected transport, so a PR opened between passes is picked up on the
// very next pass with no caller-maintained list. The routable set *is* the
// transport's current answer.
//
// **No double-enrolment (criterion 3).** Idempotency lives one layer down in
// `enrollPr` (keyed on repo + prNumber + workflowId, skipping non-terminal
// runs), so an already-enrolled / in-flight PR re-discovered on a later pass
// produces `created: false` and no second run. This pass adds no state of its
// own that could drift from that guard.
//
// **Observability (criterion 2).** Every pass logs its exclusion reasons —
// both per-PR enrollment skips (unknown repo / no workflow match / unresolved
// workflow) and tolerated per-repo discovery errors — tagged with the
// triggering `DiscoveryPhase` so the upfront / mid-batch / end-of-drain
// invocations are distinguishable in the logs. The daemon's drain loop (a
// later issue) calls this at each of those points; this module is the single
// entry point all three share.
// ---------------------------------------------------------------------------

// When in the drain loop a self-discovery pass was triggered. The daemon runs
// discovery upfront, opportunistically mid-batch when a worker slot frees, and
// at the end of each drain (lifecycle design §6, issue #108). The phase is
// purely an observability tag — the discover→enroll logic is identical at each
// point — so a log line can attribute an enrolment or exclusion to its trigger.
export enum DiscoveryPhase {
  EndOfDrain = "end_of_drain",
  MidBatch = "mid_batch",
  Upfront = "upfront",
}

export interface SelfDiscoveryPassOptions {
  // Read-side transport the sweep lists open PRs through (real gh/MCP in
  // production, a scripted fake in tests).
  transport: PrReadTransport;
  // Resolves a matched workflowId to its loaded graph (the #122 loader in
  // production); an unknown id resolves to undefined and the PR is skipped.
  resolveWorkflow: WorkflowResolver;
  // Which drain-loop trigger fired this pass. Defaults to `Upfront`.
  phase?: DiscoveryPhase;
  // Forwarded to `enrollPr` for deterministic ids/clock in tests.
  enroll?: EnrollDiscoveredOptions["enroll"];
}

export interface SelfDiscoveryReport extends EnrollmentReport {
  // The trigger this pass ran under, echoed for the caller / logs.
  phase: DiscoveryPhase;
  // Per-repo discovery failures the sweep tolerated (fail-open). Surfaced
  // here so the caller can react (e.g. a circuit breaker) without the failure
  // masquerading as "no PRs found".
  discoveryErrors: DiscoveryError[];
}

export async function runSelfDiscoveryPass(
  db: Db,
  config: Config,
  options: SelfDiscoveryPassOptions,
): Promise<SelfDiscoveryReport> {
  const phase = options.phase ?? DiscoveryPhase.Upfront;

  // Recompute the routable set from live state every pass — the sweep is the
  // queue, not a stored list.
  const sweep = await discoverOpenPrs(config, options.transport);

  const report = await enrollDiscovered(
    db,
    config,
    sweep,
    options.resolveWorkflow,
    { enroll: options.enroll },
  );

  logExclusions(phase, report.skipped, sweep.errors);

  return {
    enrolled: report.enrolled,
    skipped: report.skipped,
    phase,
    discoveryErrors: sweep.errors,
  };
}

// Emit one structured warn line per exclusion so every pass's filtering is
// observable. Both enrollment skips (with their `SkipReason`) and tolerated
// per-repo discovery errors are logged, each tagged with the triggering phase.
function logExclusions(
  phase: DiscoveryPhase,
  skipped: SkippedPr[],
  discoveryErrors: DiscoveryError[],
): void {
  for (const error of discoveryErrors) {
    console.warn(
      `[self_discovery] phase=${phase} discovery_error repo=${error.repo} message=${error.message}`,
    );
  }
  for (const skip of skipped) {
    const workflowSuffix =
      skip.workflowId === undefined ? "" : ` workflowId=${skip.workflowId}`;
    console.warn(
      `[self_discovery] phase=${phase} excluded repo=${skip.pr.repo} pr=${String(skip.pr.number)} reason=${skip.reason}${workflowSuffix}`,
    );
  }
}

export type { EnrolledPr, SkippedPr };
