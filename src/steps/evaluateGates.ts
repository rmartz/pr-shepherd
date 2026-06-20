import { z } from "zod";
import {
  Activity,
  CIState,
  CopilotState,
  HoldState,
  MergeConflict,
  ReviewState,
  ThreadState,
  UATState,
} from "@/engine/derivation/state-vector";
import { decide } from "@/engine/gates";
import type { StepInstance } from "@/db/schemas";
import type { ExecutorResult, StepExecutor } from "@/engine/runner";

// ---------------------------------------------------------------------------
// `evaluate_gates` step executor (Epic 10, #100).
//
// A zero-cost (decision-type) step that bridges the typed gate model into the
// configurable workflow YAML. It reads the derived `PrStateVector` that the
// `derive_pr_state` step (#97) wrote to the run context under `state`, runs the
// provably-total `decide()` (#98), and emits `{ action, blockingGate }` as its
// output so the routing DSL (#57) can branch on `output.action`:
//
//   output.action == 'review'       → review
//   output.action == 'fix_review'   → fix_review
//   output.action == 'merge'        → merge
//   output.action == 'wait_ci'      → wait_ci
//   output.action == 'authorize_ci' → authorize_ci
//   output.action == 'rerun_ci'     → rerun_ci
//   output.action == 'wait_copilot' → wait_copilot
//   output.action == 'wait_remote'  → wait_remote
//   output.action == 'park'         → park
//   condition: "true"               → <catch-all, required by the DSL>
//
// This is the seam that keeps the *routing* configurable in YAML while the
// *decision* stays in typed, exhaustively-tested TS. The executor itself owns
// no gate logic — it parses input, delegates to `decide`, and shapes output.
//
// Cost model: this runs in-process and consumes no Claude / GitHub-API / repo
// slot. It is dispatched as a `decision`-type step, which `canAdmitStep` (#45)
// admits unconditionally via `countsAgainstRepo` returning `false`.
//
// Input contract: the workflow's step `input` carries the state vector (and any
// pure `decide` options) hoisted from `context.state`. The runner merges step
// output into the run context, so a preceding `derive_pr_state` step's
// `{ state }` output is on `context.state` by the time this step is queued; the
// workflow definition maps `context.state` into this step's `input.state`.
// ---------------------------------------------------------------------------

const PrStateVectorSchema = z.object({
  activity: z.enum(Activity),
  ci: z.enum(CIState),
  conflict: z.enum(MergeConflict),
  copilot: z.enum(CopilotState),
  hold: z.enum(HoldState),
  review: z.enum(ReviewState),
  threads: z.enum(ThreadState),
  uat: z.enum(UATState),
});

const DecideOptionsSchema = z.object({
  copilotUnavailable: z.boolean().optional(),
  skipUat: z.boolean().optional(),
});

export const EvaluateGatesInputSchema = z.object({
  state: PrStateVectorSchema,
  options: DecideOptionsSchema.optional(),
});
export type EvaluateGatesInput = z.infer<typeof EvaluateGatesInputSchema>;

// Synchronous body wrapped in `Promise.resolve` to satisfy the async
// `StepExecutor` contract without an `async` function that has no `await`. A
// malformed `input` makes `parse` throw synchronously; the runner invokes the
// executor inside its `try { await executor(step) }`, so that throw is recorded
// as a failed step exactly like a rejected promise would be.
export const evaluateGatesExecutor: StepExecutor = (
  step: StepInstance,
): Promise<ExecutorResult> => {
  const { state, options } = EvaluateGatesInputSchema.parse(step.input);
  const { action, blockingGate } = decide(state, options ?? {});
  return Promise.resolve({ output: { action, blockingGate } });
};
