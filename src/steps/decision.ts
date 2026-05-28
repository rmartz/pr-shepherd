import type { StepExecutor } from "@/engine/runner";

// ---------------------------------------------------------------------------
// `decision` step executor (vision §4.3).
//
// A decision step is a zero-cost in-process branching point. It has no
// input, no output, and no external side effects — its sole reason to
// exist is to let workflow authors express pure routing logic ("if
// context.lastVerdict == 'approved' && context.allChecksPassed, go to
// merge; otherwise go to wait_author_push") without paying for a Claude,
// GitHub-API, or per-repo concurrency slot.
//
// The actual routing happens *after* this executor returns, in the
// routing layer (#57) that evaluates the step's routing rules against
// the merged `{output, context}`. This executor's only job is to
// satisfy the runner contract by completing successfully — the empty
// output object is the entire payload.
//
// Zero-cost admission is enforced upstream by `canAdmitStep` (#45):
// `Decision` is one of the two step types that short-circuit the cap
// checks (the other is `Fork`). The corresponding test in
// `decision.spec.ts` pins that invariant against a fully-saturated
// `ActiveCounts` so a future refactor cannot silently start charging
// decision steps to one of the caps.
// ---------------------------------------------------------------------------

export const decisionExecutor: StepExecutor = () =>
  Promise.resolve({ output: {} });
