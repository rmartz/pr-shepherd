import type { StepExecutor } from "./types";

// ---------------------------------------------------------------------------
// Placeholder executor used during Epic 3 to exercise the engine
// (runner dispatch, routing, recovery) before the real `claude_skill`,
// `github_api`, `wait_author_push`, `wait_external`, `decision`, and
// `fork` executors land
// in Epic 4 (#7). It produces no side effects and returns an empty
// output object so the routing layer sees a deterministic, content-free
// completion. Tests that wire workflows together can register
// `noopExecutor` for any step type they do not yet want to fan out into
// a real implementation.
// ---------------------------------------------------------------------------

export const noopExecutor: StepExecutor = () => Promise.resolve({ output: {} });
