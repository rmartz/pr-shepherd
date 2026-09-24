---
type: Reference
title: PR Dispatcher (interim coordinator)
description: A label-driven, cross-repo poller that dispatches /review, /fix-review, or /merge from the labels pr-lifecycle maintains — a stopgap for the dotfiles coordinator until the daemon ships.
resource: src/dispatcher/
tags: [cli, dispatcher, coordinator, labels]
---

# PR Dispatcher (interim coordinator)

`pnpm dispatch` (`src/dispatcher/cli.ts`) is a small standalone poller that replaces the dotfiles coordinator (`pr_review_iteration.py` / `pr_route.py`) while the full daemon is still in progress. It deliberately owns **no routing logic**: pr-lifecycle and merge-safety already reduce each PR's state to a label, so the dispatcher only maps a label search to a skill. It is independent of the engine, Firestore, and the `shepherd` CLI.

## Rules

Each rule is a global GitHub search (`is:pr involves:@me state:open archived:false draft:false`, narrowed to `user:<owner>`), listed in priority order. A PR matching several searches is dispatched only for the first rule that matches.

| Rule                | Label filter                                                     | Skill         |
| ------------------- | ---------------------------------------------------------------- | ------------- |
| `merge-conflict`    | `merge conflict`, not `escalation needed`                        | `/fix-review` |
| `changes-requested` | `changes requested`, not `blocked` / `escalation needed`         | `/fix-review` |
| `review-requested`  | `review requested`, not `blocked` / `escalation needed`          | `/review`     |
| `approved`          | `approved`, not `blocked` / `do not merge` / `escalation needed` | `/merge`      |

Rules live in `src/dispatcher/rules.ts`. To change routing, edit that file (or let pr-lifecycle change the labels). Do not add state inspection to the dispatcher.

## Dispatch

Each job runs `claude -p [--claude-arg …] -- "/<skill> <number>"` with its cwd set to `<repos-root>/<repo-name>`, which is the root checkout the dotfiles skills expect. A repo with no local checkout is skipped, and the skip is logged once. Each job's output goes to its own file in `--log-dir`.

- **Concurrency:** at most `--concurrency` jobs run at once, with at most one job per PR.
- **Timeout:** a job is SIGTERMed after `--timeout` minutes.
- **Stall guard:** labels move asynchronously, so a PR can still carry its trigger label right after a skill finishes. Two guards are keyed on `(skill, headSha)`:
  - A `--cooldown` delays each re-dispatch.
  - After `--max-attempts` attempts, the PR is skipped until its head SHA or routed skill changes.
- **State:** all state lives in memory. Restarting the dispatcher resets the guards.
- **Signals:** the first SIGINT/SIGTERM stops scheduling new jobs and waits for running ones to finish. A second signal kills them.

```bash
pnpm dispatch --dry-run --once          # list what would run
pnpm dispatch --rule review-requested   # only reviews
pnpm dispatch --concurrency 2 --claude-arg=--model --claude-arg=opus
```

Run `pnpm dispatch --help` for every option and its default.
