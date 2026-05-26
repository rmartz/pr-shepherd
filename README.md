# PR Shepherd

A locally-hosted, low-weight daemon that automates the full PR review → fix → merge lifecycle across multiple repositories using Claude, with a Vercel-hosted reactive web UI for monitoring workflow runs.

PR Shepherd replaces the "run delegate in a loop" model with a durable, event-driven workflow engine. Claude invocations become discrete, retryable step instances whose inputs, outputs, and timing are stored persistently in hosted Firestore. A separate Next.js UI deployed to Vercel reads run state via Firestore's `onSnapshot` subscriptions — the daemon itself is headless and hosts no HTTP surface.

For the full design rationale and architecture details, see the [vision document](https://github.com/rmartz/pr-shepherd/issues/1) (split deployment topology is documented in §15).

## Stack

| Layer           | Technology                                                                                                              | Purpose                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Runtime         | [Node.js](https://nodejs.org/) 24 LTS                                                                                   | First-class `child_process` for the Claude CLI           |
| Language        | TypeScript (strict mode)                                                                                                | Schema safety across DB ↔ engine ↔ API boundary          |
| Package Manager | [pnpm](https://pnpm.io/)                                                                                                | Fast, disk-efficient dependency management               |
| Data store      | Hosted Firestore (default), Firebase Emulator, or RxDB + LevelDB                                                        | Adapter-agnostic; chosen per `config.yaml`               |
| Web framework   | [Next.js](https://nextjs.org/) (App Router, standard `next start` on Vercel)                                            | UI views — deployed independently of the daemon          |
| UI components   | [ShadCN UI](https://ui.shadcn.com/) + [Tailwind CSS](https://tailwindcss.com/)                                          | Composable, accessible component primitives              |
| UI state        | Zustand + Firestore `onSnapshot`                                                                                        | Reactive run/step updates pushed by Firestore            |
| UI auth         | Firebase Auth (Google sign-in, email allowlist in `firestore.rules`)                                                    | Gates UI access; daemon has no auth (admin SDK bypasses) |
| CLI             | `commander`                                                                                                             | Single `shepherd` binary for start / status / inspection |
| Testing         | [Vitest](https://vitest.dev/) + [@testing-library/react](https://testing-library.com/docs/react-testing-library/intro/) | Unit, component, and integration tests                   |
| Visual testing  | [Storybook](https://storybook.js.org/)                                                                                  | Component development and visual documentation           |
| Monitoring      | [Sentry](https://sentry.io/)                                                                                            | Daemon error tracking                                    |
| CI/CD           | GitHub Actions                                                                                                          | Lint, format, test, build on every PR                    |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v24+
- [pnpm](https://pnpm.io/) v10+
- A [Firebase project](https://console.firebase.google.com/) with Firestore enabled — the default data-store adapter. Alternatives are documented in [ARCHITECTURE.md](ARCHITECTURE.md#data-store).
- A GitHub personal access token authorized via the [`gh` CLI](https://cli.github.com/) for the repos the daemon will watch.
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and authenticated — the daemon spawns it as a subprocess for `claude_skill` steps.

### Install

1. Clone the repository.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Copy the environment template and fill in your Firebase credentials:
   ```bash
   cp .env.example .env.local
   ```
4. Copy the daemon config example and edit it to declare which repos to watch:
   ```bash
   cp config.example.yaml config.yaml
   ```
   See [ARCHITECTURE.md](ARCHITECTURE.md#configuration) for the full config schema.

### Run

PR Shepherd has two independently deployable surfaces:

**Daemon (local, headless)**:

```bash
shepherd start
```

Boots the engine on your machine. The daemon polls GitHub for new PRs in the configured repos, enrolls them in their assigned workflow, and writes run/step state to Firestore via the admin SDK. It does **not** host an HTTP server.

**UI (Vercel)**:

```bash
vercel deploy
```

Deploys the Next.js UI to Vercel. Configure `NEXT_PUBLIC_FIREBASE_*` environment variables in the Vercel project to point at the same Firebase project the daemon writes to. Visitors authenticate via Firebase Auth (Google sign-in); access is gated by the email allowlist in `firestore.rules`. The UI reads live state from Firestore via `onSnapshot` — no SSE, no custom server, no port forwarding.

See ARCHITECTURE.md (#deployment-topology) and vision #1 §15 for the rationale.

## Common Commands

```bash
pnpm dev              # Start dev server (UI only, no engine)
pnpm build            # Production build
pnpm lint             # Lint with ESLint
pnpm format           # Format with Prettier
pnpm format:check     # Check formatting
pnpm test             # Run tests with Vitest
pnpm tsc              # Type check
pnpm storybook        # Start Storybook dev server (port 6006)
pnpm build-storybook  # Build static Storybook
pnpm run env:pull     # Pull .env.local from Vercel
pnpm run env:validate # Validate deployment config files against schema
pnpm run secrets-check # Run config validation + gitleaks scan (also runs on every commit)
```

## Configuration

PR Shepherd is configured by two files:

- **`config.yaml`** (gitignored) — operator config: which repos to watch, concurrency limits, polling intervals, data-store adapter. See [`config.example.yaml`](config.example.yaml) for the schema.
- **`workflows/*.yaml`** — workflow definitions: named steps and routing rules. Hot-reloaded on change. See `workflows/base-pr.yaml` and `workflows/dependabot-pr.yaml` for the bundled defaults.

Secrets (Firebase service account, Sentry token) live in `.env.local` and are never committed.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — Technical decisions, data model, engine, data-store options.
- [AGENTS.md](AGENTS.md) — Code standards and conventions for AI-assisted development.
- [CONTRIBUTING.md](CONTRIBUTING.md) — Branch naming, commit conventions, PR workflow.
- [Vision document (issue #1)](https://github.com/rmartz/pr-shepherd/issues/1) — Full design rationale, open questions, success criteria.

## License

MIT
