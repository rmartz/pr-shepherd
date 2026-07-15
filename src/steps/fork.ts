import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Collections } from "@/db/collections";
import type { StepType } from "@/db/schemas";
import {
  RunStatus,
  StepStatus,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import type { Db } from "@/db/types";
import type { ExecutorResult, StepExecutor } from "@/engine/runner";

// ---------------------------------------------------------------------------
// `fork` step executor (vision §4.3, §5.2).
//
// A `fork` step creates a child `workflowRun` and seeds its first
// `stepInstance`, linking the child to the parent via
// `workflowRun.parentRunId` and the parent's `childRunIds`. This is how
// the Dependabot workflow's `spawn_fix_pr` step launches a fix-PR child
// run (§5.2).
//
// Depth cap (default 5, configurable via `maxDepth`) prevents infinite
// fork chains caused by a workflow accidentally forking its own
// descendants. The cap is exclusive and applies to the *would-be child*'s
// depth: `child.depth = chain.length` where `chain` is the run lineage
// from root to the fork step's current run inclusive. A fork whose child
// would land at depth `>= maxDepth` raises an error that identifies
// every link in the chain so an operator can pinpoint the runaway lineage.
//
// Zero-cost admission is enforced upstream by `canAdmitStep` (#45): a
// `Fork` candidate short-circuits every cap.
//
// The executor takes a `Db` handle (it has to create new docs) and a
// `firstStepFactory(workflowId)` callback that returns the first step's
// definition id, type, and input. The workflow loader (separate
// sub-issue) will wire that callback in production; tests stub it inline.
// ---------------------------------------------------------------------------

export const DEFAULT_FORK_MAX_DEPTH = 5;

export const ForkInputSchema = z.object({
  workflowId: z.string().min(1),
  prNumber: z.number().int().nonnegative(),
  initialContext: z.record(z.string(), z.unknown()).default({}),
});
export type ForkInput = z.infer<typeof ForkInputSchema>;

export interface FirstStepSpec {
  stepDefinitionId: string;
  stepType: StepType;
  input: Record<string, unknown>;
}

export interface ForkOptions {
  // Resolves a workflow id to the first step the child run should start
  // on. Required — the executor cannot guess this without parsing the
  // workflow definition (the workflow loader is a separate sub-issue).
  firstStepFactory: (workflowId: string) => Promise<FirstStepSpec>;
  // Override the default chain-length cap of 5.
  maxDepth?: number;
  // Test-injectable id factory + clock. Defaults to crypto.randomUUID
  // and Date.now in production.
  newId?: () => string;
  now?: () => number;
}

export function createForkExecutor(db: Db, opts: ForkOptions): StepExecutor {
  const maxDepth = opts.maxDepth ?? DEFAULT_FORK_MAX_DEPTH;
  // Validate at construction time so configuration mistakes (e.g. `0`
  // from an unvalidated YAML field) surface eagerly rather than silently
  // making every fork either always-allow or always-reject.
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error(
      `fork maxDepth must be a positive integer (>= 1); got ${String(maxDepth)}`,
    );
  }
  const newId = opts.newId ?? (() => randomUUID());
  const now = opts.now ?? Date.now;

  return async (step: StepInstance): Promise<ExecutorResult> => {
    const input = ForkInputSchema.parse(step.input);

    // Walk the parent chain rooted at this fork step's run. The
    // resulting `chain` array is ordered root → ... → current.
    const chain = await loadChain(db, step.runId);
    if (chain.length >= maxDepth) {
      throw new Error(
        `fork depth cap exceeded (would-be child depth ${String(chain.length)} meets cap ${String(maxDepth)}): current chain is ${chain
          .map((r) => r.id)
          .join(" → ")}`,
      );
    }

    const parent = chain[chain.length - 1];
    if (parent === undefined) {
      throw new Error(
        `fork step ${step.id} references runId ${step.runId} which does not exist`,
      );
    }

    const childRunId = newId();
    const createdAt = now();
    const childRun: WorkflowRun = {
      id: childRunId,
      workflowId: input.workflowId,
      workflowVersion: 1,
      repo: parent.repo,
      prNumber: input.prNumber,
      prTitle: "",
      status: RunStatus.Pending,
      parentRunId: parent.id,
      childRunIds: [],
      context: input.initialContext,
      createdAt,
      updatedAt: createdAt,
      metrics: {
        totalClaudeMs: 0,
        totalActiveMs: 0,
        totalScheduleWaitMs: 0,
        totalExternalWaitMs: 0,
      },
    };
    await db.create(Collections.workflowRuns, childRun);

    const firstSpec = await opts.firstStepFactory(input.workflowId);
    const firstStep: StepInstance = {
      id: newId(),
      runId: childRunId,
      stepDefinitionId: firstSpec.stepDefinitionId,
      stepType: firstSpec.stepType,
      status: StepStatus.Pending,
      input: firstSpec.input,
      output: {},
      logs: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt,
      metrics: {
        claudeMs: 0,
        activeMs: 0,
        scheduleWaitMs: 0,
        externalWaitMs: 0,
      },
    };
    await db.create(Collections.stepInstances, firstStep);

    // Re-read the parent immediately before appending so a concurrent
    // fork (or other writer) is not clobbered by our stale snapshot.
    // This is a best-effort guard — the proper fix is an atomic
    // array-union primitive on the Db adapter (tracked in #79).
    const parentFresh = await db.get(Collections.workflowRuns, parent.id);
    const currentChildRunIds = parentFresh?.childRunIds ?? parent.childRunIds;
    await db.update(Collections.workflowRuns, parent.id, {
      childRunIds: [...currentChildRunIds, childRunId],
      updatedAt: createdAt,
    });

    return { output: { childRunId } };
  };
}

async function loadChain(db: Db, leafRunId: string): Promise<WorkflowRun[]> {
  // Walk parentRunId pointers from leaf back to root, then reverse so
  // the returned array reads root → ... → leaf (which is the order the
  // error message wants when the cap is exceeded). A `visited` set
  // detects cycles introduced by data corruption; a missing parent
  // pointer throws rather than silently truncating the chain (which
  // would undercount depth and allow forks to bypass the cap).
  const reverseChain: WorkflowRun[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = leafRunId;
  while (currentId !== undefined) {
    if (visited.has(currentId)) {
      throw new Error(
        `fork chain cycle detected at run ${currentId}: visited ids are ${[...visited].join(", ")}`,
      );
    }
    visited.add(currentId);
    const run: WorkflowRun | undefined = await db.get(
      Collections.workflowRuns,
      currentId,
    );
    if (run === undefined) {
      // The very first lookup missing means the fork step references a
      // run that no longer exists — surface that distinctly. A missing
      // ancestor mid-walk means data corruption (a parentRunId pointing
      // at a deleted run), which we also surface so the cap is never
      // bypassed by a truncated chain.
      throw new Error(
        reverseChain.length === 0
          ? `fork step references runId ${currentId} which does not exist`
          : `fork chain references missing parent run ${currentId}; chain so far: ${reverseChain
              .map((r) => r.id)
              .reverse()
              .join(" → ")}`,
      );
    }
    reverseChain.push(run);
    currentId = run.parentRunId;
  }
  return reverseChain.reverse();
}
