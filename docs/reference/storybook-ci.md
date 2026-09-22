---
type: Reference
title: Storybook CI (shared rmartz/storybook-ci)
description: The two thin caller workflows that delegate pr-shepherd's gating Storybook tests and advisory screenshot gallery to the shared rmartz/storybook-ci reusable workflows, the local Vitest browser project they depend on, and the trigger-policy divergence from issue #256.
tags: [ci, storybook, screenshots, testing, devops]
---

# Storybook CI (shared `rmartz/storybook-ci`)

pr-shepherd's Storybook CI is delegated to the shared
[`rmartz/storybook-ci`](https://github.com/rmartz/storybook-ci) reusable workflows rather than
hand-rolled here. Two thin callers consume it, each pinned by full commit SHA with the `# vX.Y.Z`
comment Dependabot reads to keep the pin current:

| Caller                                        | Nature       | Called jobs                          |
| --------------------------------------------- | ------------ | ------------------------------------ |
| `.github/workflows/storybook-tests.yml`       | **gating**   | `Storybook Tests`, `Storybook Build` |
| `.github/workflows/storybook-screenshots.yml` | **advisory** | `Storybook Screenshots`              |

The operational reasoning we would otherwise maintain a private copy of — Chromium provisioning
and binary caching with a retry, docs-only change gating, fail-vs-cancel deadline budgeting, per-PR
concurrency, fork exclusion, advisory isolation — lives upstream once. A fix there reaches us
through a pin bump instead of an edit.

## What this delivers

Adoption satisfies the three issues that specified this pipeline while it was still
"create-now, build-later", all gated on the first `.stories.*` files existing:

- **[#255](https://github.com/rmartz/pr-shepherd/issues/255)** — the gating real-browser story
  suite. Its open decision ("do we need a real browser, or does headless suffice?") resolves to
  **yes**: the shared workflow's default test command is the browser project, so the marginal cost
  of the browser job is now a pinned `uses:` line rather than bespoke Playwright plumbing. Headless
  `.spec.tsx` coverage stays in the `components` project, untouched.
- **[#256](https://github.com/rmartz/pr-shepherd/issues/256)** — `build-storybook` runs as its own
  gating job on the broad code-change (denylist) gate, distinct from the framework `pnpm build`,
  and the story suite runs on every PR with no path gate. See the divergence below on the
  screenshot trigger.
- **[#202](https://github.com/rmartz/pr-shepherd/issues/202)** — the advisory screenshot gallery,
  including its make-or-break integration step (below).

## Why the hosting scheme matters here

pr-shepherd's screenshots are **machine-consumed**: `/review` and `/merge` scan a PR's comments for
image URLs and assess them as a visual check. That scan matches only
`github.com/user-attachments/...` and `user-images.githubusercontent.com/...`.

`storybook-ci` uploads gallery images with `gh --attach`, which hosts them as GitHub
user-attachments — already a scheme those skills recognize. So #202's acceptance criterion
"widen the screenshot-URL recognition to the chosen host's scheme" needs **no** widening, and the
per-PR orphan image branch that criterion was written against never exists: there is no branch to
write, so the caller needs no `contents: write` and there is no cleanup workflow.

## The local Vitest `storybook` project

The gating story suite is a Vitest **browser-mode** project in `vitest.config.mts`, rendering every
story in headless Chromium through `@storybook/addon-vitest`. It is the fifth project alongside the
four headless ones (`node`, `hooks`, `components`, `tooling`).

Because it needs a Playwright browser binary, the `Tests` job in `ci-actions.yml` **enumerates the
headless projects explicitly** rather than running `pnpm test`:

```bash
pnpm exec vitest run --project node --project hooks --project components --project tooling
```

Keeping the browser project out of that job is what lets it stay fast and skip the Playwright
install. `pnpm test` (bare `vitest`) still runs **all five** projects, so locally it needs the
browser binary once:

```bash
pnpm exec playwright install chromium
```

No `with:` block is needed in either caller: the shared defaults
(`pnpm exec vitest run --project storybook`, `pnpm build-storybook`) already match this repo's
project name and package script.

## Recorded decision: no production-bundle render gate

[#255](https://github.com/rmartz/pr-shepherd/issues/255) asks for an explicit decision on adding a
`@storybook/test-runner --url` gate that renders every story against the _served_ static build.

**Decision: do not add it.** The coverage we have is the browser story suite (the addon-vitest
transform/mount render path) plus the gating `build-storybook` _compile_ check. The residual gap is
narrow — "compiles, passes Vitest, throws only in the production-bundle render" — and closing it
costs a third full browser render pass on every PR. That is the proportionality trade-off the fleet
guidance explicitly names as a legitimate choice. Revisit only if a production-bundle-only render
break actually appears.

## Required checks

A reusable workflow's check context is `<caller job> / <called job>`, **not** the bare job name. To
require the gating suite on the default branch, the ruleset entries are:

- `storybook-tests / Storybook Tests`
- `storybook-tests / Storybook Build`

This is safe to require because gating is the shared workflow's `detect-changes` job plus per-job
`if:` — a skipped required job counts as passing. It is why `storybook-tests.yml` deliberately
carries **no** `on.paths`: a required check that never runs because its paths did not match hangs
the PR forever. The advisory screenshots caller is never a required check, so it may safely use
`on.paths`.

## Divergence from #256's screenshot trigger

[#256](https://github.com/rmartz/pr-shepherd/issues/256) specifies screenshots regenerate **only**
when a Storybook test (a `*.stories.tsx` file) changes, reasoning that unchanged tests already
assert unchanged behavior.

We run the shared default resolver, **`colocation`**: directly changed stories _plus_ stories
co-located with any changed component, with a `.storybook/**` change forcing a full capture. That
closes a false negative — a component edited without touching its story would otherwise regenerate
nothing, even though its rendered appearance changed — which matters more here than in a repo with
a human-only audience, since the gallery feeds an automated visual check.

This is deliberately broader than #256's stated policy. #256 is **left open** rather than silently
resolved against its own rationale; `screenshot-resolver: changed-stories-only` is a one-line
caller input if we decide the narrow gate was right. The `on.paths` filter is `src/**` (not
`*.stories.*`) to match the wider resolver.

## Authentication

The screenshots caller passes `secrets: inherit` to forward **`STORYBOOK_SCREENSHOT_PAT`**, required
because the user-attachments upload endpoint rejects the Actions `GITHUB_TOKEN`. It must be an
**Actions** secret (an Agent secret is not readable by Actions).

Upstream's `docs/authentication.md` says a _classic_ PAT with `repo` scope is required; that is an
inference, and [rmartz/storybook-ci#12](https://github.com/rmartz/storybook-ci/issues/12) settled
that a **fine-grained** PAT scoped to this one repository with **`Pull requests: Read and Write`**
and nothing else is sufficient — `Contents` is not needed, since `actions/checkout` uses the job's
`GITHUB_TOKEN`. Prefer the fine-grained token: a classic `repo`-scoped PAT would grant full
read/write across every repository the owner can reach.

Until the secret is set, the shared workflow's preflight step posts one non-blocking advisory PR
comment and skips the build and capture, so a missing PAT announces itself rather than looking like
success. The job is skipped entirely on fork PRs so the PAT never reaches fork-authored code.

## Consumer-isolation note

This repo has an `.npmrc` (`node-linker=isolated`). That is the exact consumer shape upstream
[#13](https://github.com/rmartz/storybook-ci/issues/13) addressed: as of **v1.2.1** the capture
bundle is checked out and built in `$RUNNER_TEMP`, outside this workspace, so nothing in our
`.npmrc` or lockfile affects it and we need not grant `packages: read` or pass a registry token.

## Related

- [rmartz/storybook-ci](https://github.com/rmartz/storybook-ci) — the shared workflows; `docs/consuming.md` documents the caller surface.
- [rmartz/hidden-role-game#907](https://github.com/rmartz/hidden-role-game/pull/907) — the fleet migration this repo's adoption follows.
- [storybook-screenshot-ci.md guidance](https://github.com/rmartz/ai/blob/main/docs/guidance/storybook-screenshot-ci.md) — the canonical fleet guidance whose conclusions the shared workflow implements.
