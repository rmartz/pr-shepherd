// Production GitHub adapters (#290): `gh`-CLI-backed transports the daemon wires
// into the step executors. The read transport implements `GithubReadTransport`
// (for `derive_pr_state`); the write transport (`GithubTransport` for
// `github_api`) is the companion piece.
export { createGithubReadTransport } from "./readTransport";
export {
  defaultGhExec,
  isRateLimitResult,
  type GhCommand,
  type GhExec,
  type GhResult,
} from "./ghExec";
