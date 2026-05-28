import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  StepType,
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
// descendants. The cap counts the chain length: a fork attempted from a
// run whose chain (root → … → current) already has `maxDepth` ancestors
// raises a parse-clear error identifying every link in the chain so an
// operator can pinpoint the runaway lineage.
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
  const newId = opts.newId ?? (() => randomUUID());
  const now = opts.now ?? Date.now;

  return async (step: StepInstance): Promise<ExecutorResult> => {
    const input = ForkInputSchema.parse(step.input);

    // Walk the parent chain rooted at this fork step's run. The
    // resulting `chain` array is ordered root → ... → current.
    const chain = await loadChain(db, step.runId);
    if (chain.length >= maxDepth) {
      throw new Error(
        `fork depth cap exceeded (${String(chain.length + 1)} levels): current chain is ${chain
          .map((r) => r.id)
          .join(" → ")}; configured cap is ${String(maxDepth)}`,
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

    await db.update(Collections.workflowRuns, parent.id, {
      childRunIds: [...parent.childRunIds, childRunId],
      updatedAt: createdAt,
    });

    return { output: { childRunId } };
  };
}

async function loadChain(db: Db, leafRunId: string): Promise<WorkflowRun[]> {
  // Walk parentRunId pointers from leaf back to root, then reverse so
  // the returned array reads root → ... → leaf (which is the order the
  // error message wants when the cap is exceeded).
  const reverseChain: WorkflowRun[] = [];
  let currentId: string | undefined = leafRunId;
  while (currentId !== undefined) {
    const run: WorkflowRun | undefined = await db.get(
      Collections.workflowRuns,
      currentId,
    );
    if (run === undefined) break;
    reverseChain.push(run);
    currentId = run.parentRunId;
  }
  return reverseChain.reverse();
}
