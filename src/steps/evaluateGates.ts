import { z } from "zod";
import {
  Activity,
  CIState,
  CopilotState,
  DependabotRebaseState,
  HoldState,
  MergeConflict,
  ReviewState,
  ThreadState,
  UATState,
} from "@/engine/derivation/state-vector";
import { Action, decide } from "@/engine/gates";
import { VerdictLabel, reconcileVerdict } from "@/engine/guards";
import { GithubActionType, type GithubAction } from "@/steps/githubApi";
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
//   output.action == 'escalate'     → escalate
//   output.action == 'park'         → park
//   condition: "true"               → <catch-all, required by the DSL>
//
// This is the seam that keeps the *routing* configurable in YAML while the
// *decision* stays in typed, exhaustively-tested TS. The executor itself owns
// no gate logic — it parses input, delegates to `decide`, and shapes output.
//
// Escalation (#253): when `decide()` returns `escalate` (CI is persistently
// cancelled), the executor also emits `output.escalationActions` — the concrete
// `add_label` / `remove_label` batch that `reconcileVerdict` computes to make
// `escalation needed` the PR's sole verdict label. The paired `escalate`
// `github_api` step applies it. This fires exactly once: the applied label makes
// the next tick park at `NoHold` before `CiGreen` is re-reached.
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
  dependabotRebase: z.enum(DependabotRebaseState),
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
  // The PR's raw labels, its repo (`owner/name`), and number. Supplied so an
  // `escalate` decision can build the exact `escalation needed` relabel without
  // a re-fetch (#253). Optional/defaulted at the schema level: a workflow that
  // never routes escalation may omit `repo`/`pr`, and non-escalate decisions
  // never read them. They are, however, REQUIRED at runtime the moment the
  // decision is `escalate` — the executor throws if either is missing then
  // (#277), turning a would-be silent no-op into a visible failure.
  labels: z.array(z.string()).default([]),
  repo: z.string().optional(),
  pr: z.number().int().nonnegative().optional(),
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
  const { state, options, labels, repo, pr } = EvaluateGatesInputSchema.parse(
    step.input,
  );
  const { action, blockingGate } = decide(state, options ?? {});

  if (action === Action.Escalate) {
    // `repo`/`pr` are schema-optional (a workflow that never routes escalation
    // omits them), but building the escalation relabel requires both. Fail
    // loudly here rather than silently emitting no `escalationActions` — that
    // would leave the downstream `escalate` step with an `undefined` action
    // batch and no visible cause (#277).
    if (repo === undefined || pr === undefined) {
      throw new Error(
        `evaluate_gates decided '${Action.Escalate}' but its input is missing ${repo === undefined ? "repo" : "pr"}; a workflow routing the escalate action must supply both repo and pr so the escalation relabel can be built`,
      );
    }
    const mutation = reconcileVerdict(VerdictLabel.EscalationNeeded, labels);
    const escalationActions: GithubAction[] = [
      ...mutation.add.map((label): GithubAction => ({
        type: GithubActionType.AddLabel,
        params: { repo, pr, label },
      })),
      ...mutation.remove.map((label): GithubAction => ({
        type: GithubActionType.RemoveLabel,
        params: { repo, pr, label },
      })),
    ];
    return Promise.resolve({
      output: { action, blockingGate, escalationActions },
    });
  }

  return Promise.resolve({ output: { action, blockingGate } });
};
