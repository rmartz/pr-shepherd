---
type: Adapter
title: GitHub Transports (gh CLI)
description: Production gh-CLI-backed implementations of the GitHub read/write transport seams the step executors depend on, with rate-limit translation.
resource: src/github
tags: [github, transport, adapter, gh-cli, execution-loop]
---

# GitHub Transports (`gh` CLI)

The step executors read and write GitHub through injected transport seams so they stay unit-testable. `src/github` holds the **production** implementations, backed by the `gh` CLI — already the daemon's auth + API surface everywhere else. These are what let the execution loop run against real GitHub (part of [#290](https://github.com/rmartz/pr-shepherd/issues/290)).

## `gh` invocation seam

`GhExec` runs one `gh` invocation and returns `{ stdout, stderr, exitCode }`. `defaultGhExec` spawns a real `gh` subprocess (ambient env, no shell → no injection surface); tests inject a fake returning scripted results. `isRateLimitResult` classifies a failed result as a rate-limit rejection by matching `gh`'s stderr markers (primary 429/403-with-reset and secondary limits).

## Read transport

`createGithubReadTransport(exec?)` implements `GithubReadTransport` (the `derive_pr_state` snapshot read seam, #95):

- **`graphql`** sends `{ query, variables }` to the GraphQL endpoint via `gh api graphql --input -` and returns the unwrapped `data` (throwing on a `errors` payload).
- **`restPaginate`** runs `gh api --paginate <path?params>` and returns the flattened array.

**Rate-limit contract (#140):** both paths route a rate-limited result through a `GithubRateLimitError` throw _before_ any other error handling, so the derivation retry layer (`withRateLimitRetry`) engages its backoff — any other error type would bypass the retry and hard-fail the snapshot.

## Write transport

`createGithubWriteTransport(exec?)` implements `GithubTransport` (`call(action)`), the mutation seam `github_api` (#46) depends on. `buildActionCommand` (pure) maps each single-call `GithubActionType` to its `gh` invocation; the transport dispatches it, then maps the result to a `GithubTransportResult`:

- **`rate_limited`** — checked first on every path, so the executor's backoff engages.
- **`error`** — a failed `gh` call, marked `retriable` only for transient signatures (5xx / network / timeout); a 4xx is not retriable.
- **`ok`** — with the parsed response body as `data`.

**String fields use `-f` (raw-field), never `-F`:** `-F` interprets a leading `@` as "read from file", which would corrupt a body like `@dependabot rebase` or an `@`-prefixed label/comment. Only the numeric `line` uses `-F`.

One action is not a single call:

- **`authorize_ci`** is multi-step: read the PR HEAD sha, list the workflow runs in `action_required` for it, and approve each. Any failed step short-circuits to that step's result. (Re-examined for #290: no schema change makes it a single call — the run discovery is intrinsic — so it lives in the transport.)

`resolve_thread` sends a single GraphQL `resolveReviewThread` mutation via `gh api graphql --input -`; like all other single-call actions it is handled by `buildActionCommand`.

**Contract note:** `post_inline_comment` now carries a `commit_id` (the PR HEAD sha), added to the action schema so the transport does not have to re-fetch it — the emitting review skill already knows the HEAD.

## Related

- [PR State Derivation](../subsystems/pr-state-derivation.md) — the snapshot fetcher that consumes the read transport.
- [Execution Tick](../subsystems/execution-tick.md) — the loop that runs the executors these transports back.
