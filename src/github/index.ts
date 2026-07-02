// Production GitHub adapters (#290): `gh`-CLI-backed transports the daemon wires
// into the step executors. The read transport implements `GithubReadTransport`
// (for `derive_pr_state`); the write transport implements `GithubTransport`
// (for `github_api`).
export { createGithubReadTransport } from "./readTransport";
export { createGithubWriteTransport } from "./writeTransport";
export { buildActionCommand, type SingleCallAction } from "./actionCommands";
export {
  defaultGhExec,
  isRateLimitResult,
  type GhCommand,
  type GhExec,
  type GhResult,
} from "./ghExec";
