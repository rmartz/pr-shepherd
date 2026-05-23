# Contributing

Guidelines for contributing to projects built from this template.

## Prerequisites

- [Node.js](https://nodejs.org/) v24+
- [pnpm](https://pnpm.io/) v10+

## Setup

```bash
pnpm install
cp .env.example .env.local  # Fill in your Firebase credentials
pnpm dev
```

## Development Workflow

1. Create a branch from `main` using the naming convention:

   ```
   feature/description-123
   chore/description-123
   refactor/description-123
   docs/description-123
   ```

   Where `123` is the issue number.

2. Make your changes following the conventions in [AGENTS.md](AGENTS.md).

3. Run checks locally before pushing:

   ```bash
   pnpm lint
   pnpm format:check
   pnpm test
   pnpm build
   ```

4. Push your branch and open a PR against `main`.

## Pre-commit Hooks

This project uses [Husky](https://typicode.github.io/husky/) with [lint-staged](https://github.com/lint-staged/lint-staged) to run checks on staged files before each commit:

- **ESLint** — Lints and auto-fixes `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` files
- **Prettier** — Formats `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.json`, `.md`, `.yml`, `.yaml` files

If a pre-commit hook fails, fix the issues and try committing again.

## Code Standards

See [AGENTS.md](AGENTS.md) for the full list of code conventions, including:

- TypeScript strict mode, no `any` types
- Named exports (except Next.js pages and Redux slices)
- Co-located test files (`Component.spec.tsx`) and stories (`Component.stories.tsx`)
- User-facing strings in co-located copy files for i18n readiness
- File size limits (~200 lines for source, ~300 lines for tests)

## Commit Messages

Use imperative verbs: **Add**, **Implement**, **Fix**, **Update**, **Extract**, **Remove**.

No `feat:`/`fix:` conventional commit prefixes.

## CI Checks

Every PR runs four parallel checks via GitHub Actions:

| Check  | Command             | Must Pass           |
| ------ | ------------------- | ------------------- |
| Tests  | `pnpm test`         | Yes                 |
| Lint   | `pnpm lint`         | Yes (zero warnings) |
| Format | `pnpm format:check` | Yes                 |
| Build  | `pnpm build`        | Yes                 |

## Storybook

When adding or modifying UI components:

1. Add or update a co-located story (`ComponentName.stories.tsx`)
2. Use mock data — never depend on Firebase or runtime providers
3. For hook-dependent components, use the presentational split pattern: extract a `ComponentNameView` that accepts callbacks

Run Storybook locally:

```bash
pnpm storybook
```

## Testing

- Use `vitest` with `@testing-library/react`
- Co-locate tests with source files
- Use `describe`/`it` (not `test`)
- Use `make{Domain}()` factory functions for test fixtures
- Assert against copy constants, not hardcoded strings

Run tests:

```bash
pnpm test
```
