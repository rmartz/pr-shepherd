# Technical Architecture Reference

This document captures non-business-logic technical decisions, patterns, and infrastructure setup for the PR Shepherd daemon. For the full design rationale and open questions, see the [vision document](https://github.com/rmartz/pr-shepherd/issues/1). For the goal-state design of the PR-lifecycle subsystem (state model, gate model, orchestration, and the polling→webhooks evolution), see [docs/design/pr-lifecycle.md](docs/design/pr-lifecycle.md).

## Stack

| Layer           | Technology                                    | Purpose                                                  |
| --------------- | --------------------------------------------- | -------------------------------------------------------- |
| Runtime         | Node.js 24 LTS                                | Ships everywhere; first-class `child_process` for Claude |
| Language        | TypeScript (strict mode)                      | Schema safety across DB ↔ engine ↔ API boundary          |
| Package Manager | pnpm                                          | Fast, disk-efficient dependency management               |
| Data store      | Firestore (hosted/emulator) or RxDB + LevelDB | Adapter-agnostic; configured per `config.yaml`           |
| Web framework   | Next.js (App Router, deployed to Vercel)      | UI views — deployed independently of the daemon          |
| UI components   | ShadCN UI + Tailwind CSS                      | Composable, accessible component primitives              |
| UI state        | Zustand + Firestore `onSnapshot`              | Reactive run/step updates pushed by Firestore            |
| UI auth         | Firebase Auth (Google sign-in + allowlist)    | Gates UI access; daemon has no auth                      |
| CLI             | `commander`                                   | Single `shepherd` binary (daemon-side only)              |
| Testing         | Vitest + @testing-library/react               | Unit, component, and integration tests                   |
| Visual testing  | Storybook                                     | Component development                                    |
| Monitoring      | Sentry                                        | Daemon error tracking                                    |
| CI/CD           | GitHub Actions                                | Lint, format, test, build on every PR                    |

## Deployment Topology

PR Shepherd ships as **two independently deployable surfaces** that share state through hosted Firestore. The full rationale is in vision #1 §15; the practical consequences are:

| Surface    | Where it runs                                | What it does                                                                                                                                                                       | How it reaches the other                     |
| ---------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Daemon** | Locally on the operator's machine (headless) | Engine + step executors. Spawns `claude`, `gh`, and CI-polling subprocesses. Writes run/step state to Firestore via the admin SDK.                                                 | Writes (admin SDK bypasses Firestore rules). |
| **UI**     | Vercel                                       | Next.js App Router app. Reads run state via Firestore client-SDK `onSnapshot` subscriptions. Authenticates operators via Firebase Auth (Google sign-in, email allowlist in rules). | Reads (rules-gated).                         |

The daemon does **not** host an HTTP server. There is no `server.ts`, no `app/api/events/route.ts`, no SSE endpoint, no port to expose. The Vercel UI uses the standard `next start` entrypoint that Vercel auto-detects.

Operator → daemon control actions (toggle a repo's `enabled`, force-retry a step) flow through a `commands` collection in Firestore: the UI writes a command document, the daemon's admin-SDK subscription picks it up and acts.

## Daemon Overview

The daemon is a single Node.js process that:

1. Polls GitHub for new pull requests in configured repositories.
2. Enrolls each new PR into a versioned workflow definition (`base-pr` or `dependabot-pr`).
3. Drives the workflow through discrete, retryable step instances — invoking Claude as a subprocess for review/fix-review/merge steps, polling CI/Copilot for wait steps, and calling the GitHub API for label/comment steps.
4. Writes run/step/command state to Firestore via the admin SDK so the Vercel UI can observe it live.

The daemon is **crash-safe**: every step writes to the data store before, during, and after execution. On restart, in-flight runs resume from the failed step rather than from scratch. Step idempotency at the GitHub API level (label changes, comment posts) makes retries safe.

For the full lifecycle, engine model, and resilience guarantees, see vision §3–§8.

## Project Structure

The repository layout follows vision §12:

```
pr-shepherd/
├── src/
│   ├── app/                          # Next.js App Router (UI — Vercel)
│   │   ├── sign-in/                  # Firebase Auth sign-in page
│   │   ├── runs/                     # Run List + Run Detail views
│   │   └── repos/                    # Repository List view
│   ├── components/                   # Shared React components ("use client")
│   │   └── auth/                     # AuthProvider, AuthGate
│   ├── store/                        # Zustand store + Firestore onSnapshot subscriptions
│   ├── hooks/                        # Reactive hooks (useAuth, useWorkflowRuns, …)
│   ├── db/                           # Data layer (adapter-agnostic, shared with daemon)
│   │   ├── index.ts                  # DB interface
│   │   ├── adapters/                 # firebaseHosted / firebaseEmulator / leveldb
│   │   ├── schemas/                  # Zod schemas
│   │   └── migrations/               # Versioned migration scripts
│   ├── engine/                       # Daemon-only: scheduler, runner, routing, recovery, metrics
│   ├── steps/                        # Daemon-only: step executors (claude_skill, wait_external, etc.)
│   ├── config/                       # Daemon-only: config + workflow YAML loaders
│   └── cli/                          # Daemon-only: shepherd binary (commander)
├── workflows/                        # Workflow YAML definitions (base-pr, dependabot-pr, …)
├── config.yaml                       # Operator config (gitignored)
├── config.example.yaml               # Committed example
├── deployment/                       # Public env config (preview, production)
├── firestore.rules                   # Rules: daemon-only writes, auth+allowlist reads
└── …config files
```

Domain code lands in `engine/`, `steps/`, and `db/`. UI work lives in `app/`, `components/`, and `hooks/`. The `db/` module is shared between the daemon and the UI: the daemon uses the admin SDK adapter; the UI uses the client SDK against the same Firestore project. There is **no `server.ts`** — the daemon doesn't run an HTTP server; the UI runs standard `next start` on Vercel.

## Data Model

The primary collections (vision §3):

| Collection            | Purpose                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commands`            | UI-issued operator control actions (pause / resume / force-retry). The daemon's [commands listener](docs/subsystems/commands-listener.md) applies and clears them. |
| `repositories`        | GitHub repos the daemon is configured to watch. Carries per-repo concurrency caps and workflow assignments.                                                        |
| `workflowRuns`        | One execution of a workflow definition for one PR. Holds the shared context object, metrics, and current step.                                                     |
| `stepInstances`       | One execution of a single step within a run. Records input snapshot, output, logs, status, timing, retries.                                                        |
| `workflowDefinitions` | Reference copy of the workflow YAML at the time the run started (audit purposes only).                                                                             |

Schemas are strict (Zod) and versioned. Migrations are stored in `src/db/migrations/`.

## Workflow Engine

The engine is a scheduler loop (vision §4) that runs every 5 seconds by default:

1. Fetches all `stepInstances` with `status: "pending"`.
2. Enforces two independent concurrency dimensions: a **global** Claude-slot cap and a **per-repo** active-step cap.
3. Transitions eligible steps to `queued`, then `running`, then dispatches to the appropriate executor.
4. Watches `heartbeatAt` on running steps; declares any step stale after 60s without a heartbeat and retries it.

On startup, recovery (§8.2) finds any `workflowRuns` left in `running` status from a prior process, marks the active steps as failed with `error: "process_restart"`, and re-enqueues them as fresh `pending` steps (respecting `maxRetries`). Steps are designed to be idempotent at the GitHub API level — re-running a review that already posted will detect the existing post and skip rather than double-posting.

## Step Executors

| Step type          | Executor                                              | Counts against | Notes                                        |
| ------------------ | ----------------------------------------------------- | -------------- | -------------------------------------------- |
| `claude_skill`     | Spawn `claude -p "<skill> <pr>"` subprocess           | global + repo  | Updates Claude time bucket                   |
| `wait_author_push` | Poll PR commits after review requested changes        | repo only      | 24h default timeout; heartbeat while waiting |
| `wait_external`    | Spawn `wait-for-ci.py` / `wait-for-copilot-review.py` | repo only      | Holds `waiting` status; no global slot used  |
| `github_api`       | Direct `gh` CLI or MCP call                           | repo only      | Label changes, comment posts, branch updates |
| `decision`         | Pure in-process routing evaluation                    | neither        | Instantaneous                                |
| `fork`             | Create child `workflowRun` + first step               | neither        | Used to spawn Dependabot fix PRs             |

`wait_external` and `wait_author_push` do not hold a global Claude slot while waiting — this prevents long external waits from blocking other repos' Claude work.

## Routing DSL

Routes are evaluated top-to-bottom; first match wins. Conditions are safe-evaluated JSONPath expressions against a merged `{output, context}` object — no arbitrary code execution.

```yaml
routing:
  - condition: "output.verdict == 'approved'"
    next: wait_copilot_review
  - condition: "output.verdict == 'changes_requested'"
    next: wait_author_push
  - condition: true # catch-all
    next: null # terminal (run complete)
```

See vision §4.4 for the full DSL spec and §5 for the bundled workflows.

## Data Store

The data model is implementation-neutral. Three adapter options are supported behind the `src/db/index.ts` interface (vision §11):

| Adapter           | Trade-off                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Hosted Firestore  | **Recommended default.** Managed durability, native reactive listeners, cross-device dashboard.       |
| Firebase Emulator | Offline-capable; same code path as hosted (flag-only switch). Requires `firebase-tools` (~300 MB).    |
| RxDB + LevelDB    | Truly embedded; single-process; no Firebase tooling. Limited query capability; no cloud upgrade path. |

The active adapter is chosen at startup from `config.yaml`. Engine and step code reference only the adapter-agnostic interface.

## Configuration

Two configuration surfaces:

- **`config.yaml`** at the repo root (gitignored; `config.example.yaml` committed). Operator config: repositories to watch, concurrency limits, polling intervals, data-store adapter, server port. See vision §9 for the schema.
- **`workflows/*.yaml`** — workflow definitions, hot-reloaded by the engine on change. See vision §5.

Public, non-secret deployment config (Firebase project IDs, Sentry org/project, `NEXT_PUBLIC_*` keys) lives in `deployment/{env}.yml` and is validated against `deployment/schema.yml` on every commit and in CI. Secrets never go in these files.

To update a public config value and sync to Vercel:

```bash
scripts/update-config.sh --env=preview KEY=value --sync
```

To rotate all secrets with zero downtime:

```bash
pnpm exec sync-env --rotate-keys --env=preview
```

## UI

The UI is a Next.js App Router app **deployed to Vercel**, separate from the daemon process. Three primary views (vision §7):

- **`/` (Run List)** — All workflow runs with status, current step, timing badges. Child runs (fix PRs) indented under parents.
- **`/runs/[id]` (Run Detail)** — Run metadata + step timeline. Click a step row to expand input/output/logs in a drawer.
- **`/repos` (Repository List)** — Configured repos with enabled toggle, concurrency usage, 24h activity counts.

Plus `/sign-in` — the public entry point for Firebase Auth (Google sign-in). The `AuthGate` component in the root layout redirects unauthenticated requests to `/sign-in`; the email allowlist in `firestore.rules` enforces the actual access control on data reads.

### Live updates

Live updates come from **Firestore `onSnapshot` subscriptions** in the client SDK — not SSE, not WebSockets, not a custom server. Whenever the daemon writes to `workflowRuns` or `stepInstances` via the admin SDK, Firestore pushes the delta to every subscribed client (laptop, phone, second monitor). The UI's Zustand store patches the affected row without a full reload.

There is no SSE endpoint, no `app/api/events/route.ts`, and no daemon-side HTTP surface.

### Operator → daemon control plane

Operator actions that originate in the UI (toggling a repo's `enabled` flag, force-retrying a step, pausing the scheduler) flow through a `commands` collection in Firestore:

1. UI writes a document to `commands/{commandId}` with the user's intent. An auth-only write rule on that path lets allowlisted operators write; nothing else is writable from the UI.
2. The daemon's admin-SDK subscription on the `commands` collection picks up the new document and acts.
3. The daemon deletes the command document after processing.

This keeps the daemon truly headless — no HTTP endpoint to expose — while giving the UI a complete control surface.

## Timing Metrics

Each step records four mutually exclusive time buckets (vision §6):

| Bucket        | Covers                                          |
| ------------- | ----------------------------------------------- |
| Claude time   | Wall-clock of `claude_skill` subprocess         |
| Active time   | Step `running` status (non-waiting)             |
| Schedule wait | Time queued waiting for a concurrency slot      |
| External wait | Time `wait_external` spent polling CI / Copilot |

Run-level metrics are the sum of all completed step instances. Roll-up is incremental — updated as each step completes, not recomputed from scratch.

## Vitest Configuration

Three test projects in `vitest.config.mts`:

```typescript
{
  test: {
    projects: [
      {
        // Unit tests (engine, executors, utilities)
        test: { name: "node", environment: "node", include: ["src/**/*.spec.ts"] },
      },
      {
        // Hook tests (require React context)
        test: { name: "hooks", environment: "happy-dom", include: ["src/hooks/**/*.spec.ts"] },
      },
      {
        // Component tests (require DOM)
        test: { name: "components", environment: "happy-dom", include: ["src/**/*.spec.tsx"] },
      },
    ],
  },
}
```

The file extension convention (`.spec.ts` vs `.spec.tsx`) determines which project runs each test.

### Test Conventions

- Co-located with source: `Component.spec.tsx`, `utility.spec.ts`.
- Component tests use `@testing-library/react` with `afterEach(cleanup)`.
- No jest-dom matchers — use `.toBeDefined()` or `.textContent`.
- Test fixtures use `make{Domain}()` factory functions.
- Large test files split into `{module}-tests/` directories.

## Storybook Configuration

- Framework: `@storybook/nextjs-vite`.
- Addons: `addon-a11y`, `addon-docs`, `eslint-plugin-storybook`.
- Tailwind loaded via `globals.css` import in `.storybook/preview.ts`.

### Conventions

- Stories co-located as `ComponentName.stories.tsx`.
- Presentational split for hook-dependent components: `{Component}View` accepts callbacks.
- Mock data fixtures — no Firestore, no Zustand store, no Next.js router.
- ESLint: strict TS rules relaxed for `.stories.tsx`; `.storybook/` and `storybook-static/` ignored.

## ESLint Configuration

Flat config (`eslint.config.js`) with:

- `typescript-eslint` strict + stylistic type-checked rules for `src/**/*.{ts,tsx}`
- `react-hooks` plugin (rules-of-hooks + exhaustive-deps as errors)
- `eslint-plugin-storybook` flat/recommended
- Relaxed rules for test files (`*.spec.ts`) and story files (`*.stories.tsx`)
- Ignored: `dist/`, `node_modules/`, `.next/`, `storybook-static/`, `.storybook/`, `src/components/ui/`

## CI/CD Pipeline

### GitHub Actions

**Composite setup action** (`.github/actions/setup/action.yml`):

```yaml
- pnpm/action-setup (install pnpm)
- actions/setup-node (with cache: "pnpm")
- pnpm install --frozen-lockfile
```

**CI checks** (run on every PR):

| Job    | Command             | Purpose                    |
| ------ | ------------------- | -------------------------- |
| Tests  | `pnpm test`         | Vitest across all projects |
| Lint   | `pnpm lint`         | ESLint with zero warnings  |
| Format | `pnpm format:check` | Prettier check             |
| Build  | `pnpm build`        | Next.js production build   |

**Secret Scan** — Runs gitleaks and validates deployment config on every PR and push to `main`.

**Claude Code** (`issue_comment`, `pull_request_review_comment`, `issues`): Optional — runs Claude Code action when `@claude` is mentioned in issues/PRs. Requires `ANTHROPIC_API_KEY` secret.

### Vercel

The daemon itself runs locally — Vercel hosting is optional and used only to deploy the read-only UI for remote dashboard access. When using hosted Firestore, the deployed UI reads live state from any device.

- Automatic preview deployments on every PR
- Production deployment on merge to main
- Root directory: project root (no subdirectory)

## Resilience

### Heartbeat Recovery

Running steps update `heartbeatAt` every 15 seconds. On every scheduler loop iteration, any step with `heartbeatAt` older than 60 seconds is declared dead, marked failed, and (if under `maxRetries`) re-created as a new pending step with the same input snapshot. See vision §8.1.

### Crash Recovery on Startup

On process start, before the scheduler loop begins, all `workflowRuns` with `status: "running"` have their active step instances transitioned to `failed` and re-enqueued as fresh `pending` steps. Any in-flight Claude invocation that was mid-execution is retried from the beginning of that step. See vision §8.2.

### Idempotency Guards

- `claude_skill` steps: before invoking, check if the skill's expected side-effect already occurred (e.g., "approved" label present → skip `/review`, route directly to `wait_copilot_review`).
- `github_api` steps: use conditional writes where possible; check-then-act with stale-detection.
- `fork` steps: check for existing child run before spawning a duplicate.

## Environment Variables

| Variable                 | Side   | Description                                    |
| ------------------------ | ------ | ---------------------------------------------- |
| `FIREBASE_PROJECT_ID`    | Server | Firebase project ID (hosted Firestore adapter) |
| `FIREBASE_CLIENT_EMAIL`  | Server | Service account email                          |
| `FIREBASE_PRIVATE_KEY`   | Server | Service account key (literal `\n`)             |
| `NEXT_PUBLIC_FIREBASE_*` | Client | Client SDK config (for the UI)                 |
| `SENTRY_*`               | Server | Error tracking                                 |
| `GITHUB_TOKEN`           | Server | GitHub PAT for repo polling and API calls      |

`NEXT_PUBLIC_` variables are bundled into client JavaScript — this is by design. Firestore access control is enforced by security rules (deny-all by default; the daemon writes via the admin SDK).

## Initialization Checklist

When setting up the daemon for the first time:

1. Clone the repository and run `pnpm install`.
2. Copy `.env.example` to `.env.local` and fill in Firebase credentials.
3. Copy `config.example.yaml` to `config.yaml` and declare the repositories to watch.
4. Authenticate the `gh` CLI (`gh auth login`) — used by the daemon to poll GitHub and post comments.
5. Ensure the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) is installed and authenticated.
6. (Optional) Set up Vercel with GitHub integration if the UI will be deployed for remote access.
7. Run `shepherd start`.
