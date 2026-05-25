# Contributing

Guidelines for contributing to PR Shepherd.

## Prerequisites

- [Node.js](https://nodejs.org/) v24+
- [pnpm](https://pnpm.io/) v10+
- A Firebase project (or the Firebase Emulator) for local development against the hosted/emulator data-store adapters. See [ARCHITECTURE.md](ARCHITECTURE.md#data-store).
- The [`gh` CLI](https://cli.github.com/) authenticated against the GitHub account that owns the repos the daemon will exercise during development.
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and authenticated — required for any work that exercises `claude_skill` step executors.

## Setup

```bash
pnpm install
cp .env.example .env.local            # Fill in Firebase + Sentry credentials
cp config.example.yaml config.yaml    # Edit to declare repos to watch (gitignored)
pnpm dev                              # UI only — boots Next.js without the engine
shepherd start                        # Full daemon (engine + UI)
```

## Development Workflow

1. Create a branch from `main` following the project naming convention. The pattern depends on whether the work is tied to a GitHub issue:

   ```
   feat/issue-<number>-<slug>         # issue-tracked work (matches the /implement skill)
   chore/<short-description>          # non-issue maintenance
   refactor/<short-description>       # non-issue refactoring
   docs/<short-description>           # non-issue documentation
   ```

   For issue-tracked work, `<number>` is the GitHub issue number and `<slug>` is the lowercased, hyphenated issue title truncated to ~40 characters.

2. Make your changes following the conventions in [AGENTS.md](AGENTS.md).

3. Run checks locally before pushing:

   ```bash
   pnpm lint
   pnpm format:check
   pnpm test
   pnpm tsc
   pnpm build
   ```

4. Push your branch and open a PR against `main`.

## Pre-commit Hooks

This project uses [Husky](https://typicode.github.io/husky/) with [lint-staged](https://github.com/lint-staged/lint-staged) to run checks on staged files before each commit:

- **ESLint** — Lints and auto-fixes `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` files
- **Prettier** — Formats `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.json`, `.md`, `.yml`, `.yaml` files
- **Secrets check** — Runs gitleaks and validates `deployment/*.yml` against the schema.

If a pre-commit hook fails, fix the issues and try committing again.

## Code Standards

See [AGENTS.md](AGENTS.md) for the full list of code conventions, including:

- TypeScript strict mode, no `any` types
- Named exports (except Next.js pages and Storybook stories)
- Co-located test files (`Component.spec.tsx`) and stories (`Component.stories.tsx`)
- User-facing strings in co-located copy files for i18n readiness
- File size limits (~200 lines for source, ~300 lines for tests)

## Commit Messages

Use imperative verbs: **Add**, **Implement**, **Fix**, **Update**, **Extract**, **Remove**.

No `feat:`/`fix:` conventional commit prefixes inside a feature branch — those are reserved for the squash-merge commit on the PR.

PR titles must follow Conventional Commits format (`feat: …`, `fix: …`, `chore: …`). This is enforced by CI.

## CI Checks

Every PR runs four parallel checks via GitHub Actions:

| Check  | Command             | Must Pass           |
| ------ | ------------------- | ------------------- |
| Tests  | `pnpm test`         | Yes                 |
| Lint   | `pnpm lint`         | Yes (zero warnings) |
| Format | `pnpm format:check` | Yes                 |
| Build  | `pnpm build`        | Yes                 |

A separate **Secret Scan** workflow runs gitleaks and validates `deployment/*.yml` on every PR and push to `main`.

## Storybook

When adding or modifying UI components:

1. Add or update a co-located story (`ComponentName.stories.tsx`).
2. Use mock data fixtures — never depend on Firestore, the Zustand store, or runtime providers.
3. For hook-dependent components, use the presentational split pattern: extract a `ComponentNameView` that accepts callbacks.

Run Storybook locally:

```bash
pnpm storybook
```

## Testing

- Use `vitest` with `@testing-library/react`.
- Co-locate tests with source files.
- Use `describe`/`it` (not `test`).
- Use `make{Domain}()` factory functions for test fixtures (e.g., `makeWorkflowRun()`, `makeStepInstance()`).
- Assert against copy constants, not hardcoded strings.

Run tests:

```bash
pnpm test
```
