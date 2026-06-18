import type { Config, WorkflowGraph } from "@/config";
import type { Db } from "@/db/types";
import type { DiscoveredPr, DiscoverySweep } from "@/engine/discovery";
import { enrollPr, type EnrollOptions } from "./enroll";
import { matchWorkflowId } from "./match";

// ---------------------------------------------------------------------------
// Discovery → enrollment orchestration (issue #126).
//
// `enrollDiscovered` is the consumer of the discovery loop's `onDiscovered`
// hook (#125). For each discovered PR it:
//   1. Looks up the PR's repository config (skipping PRs from repos not in
//      the config, e.g. a transport that over-returns).
//   2. Matches the PR author to a `workflowId` via the repo's ordered
//      `workflows[]` map; a PR matching nothing is skipped and reported.
//   3. Resolves the matched id to a loaded `WorkflowGraph`; an unresolved id
//      (no such workflow definition) is reported rather than throwing.
//   4. Enrolls the PR idempotently via `enrollPr`.
//
// The same routine backs the self-discovery path (#108): both feed a
// `DiscoveredPr[]` through identical match-then-enroll logic. The function
// never throws on a per-PR problem — it accumulates an `EnrollmentReport` so
// one unmatched or unresolved PR does not stop the rest of the sweep from
// enrolling (mirroring discovery's fail-open contract).
// ---------------------------------------------------------------------------

export enum SkipReason {
  // The PR's repo id is not present in the daemon config.
  UnknownRepo = "unknown_repo",
  // No `workflows[].match` entry matched the PR author.
  NoMatch = "no_match",
  // A workflowId matched but no definition resolved for it.
  UnresolvedWorkflow = "unresolved_workflow",
}

export interface EnrolledPr {
  pr: DiscoveredPr;
  workflowId: string;
  runId: string;
  // `false` when the idempotency guard found an existing active run.
  created: boolean;
}

export interface SkippedPr {
  pr: DiscoveredPr;
  reason: SkipReason;
  // Set when `reason` is `UnresolvedWorkflow`: the id that failed to resolve.
  workflowId?: string;
}

export interface EnrollmentReport {
  enrolled: EnrolledPr[];
  skipped: SkippedPr[];
}

// Resolves a matched `workflowId` to its loaded definition graph. Production
// wires the #122 workflow loader (cached per id); returns `undefined` for an
// id with no on-disk definition.
export type WorkflowResolver = (
  workflowId: string,
) => WorkflowGraph | undefined;

export interface EnrollDiscoveredOptions {
  enroll?: EnrollOptions;
}

export async function enrollDiscovered(
  db: Db,
  config: Config,
  sweep: DiscoverySweep,
  resolveWorkflow: WorkflowResolver,
  options: EnrollDiscoveredOptions = {},
): Promise<EnrollmentReport> {
  const enrolled: EnrolledPr[] = [];
  const skipped: SkippedPr[] = [];

  for (const pr of sweep.discovered) {
    const repo = config.repositories.find((entry) => entry.id === pr.repo);
    if (repo === undefined) {
      skipped.push({ pr, reason: SkipReason.UnknownRepo });
      continue;
    }

    const workflowId = matchWorkflowId(pr.author, repo.workflows);
    if (workflowId === undefined) {
      skipped.push({ pr, reason: SkipReason.NoMatch });
      continue;
    }

    const graph = resolveWorkflow(workflowId);
    if (graph === undefined) {
      skipped.push({ pr, reason: SkipReason.UnresolvedWorkflow, workflowId });
      continue;
    }

    const result = await enrollPr(db, pr, graph, options.enroll);
    enrolled.push({
      pr,
      workflowId,
      runId: result.runId,
      created: result.created,
    });
  }

  return { enrolled, skipped };
}
