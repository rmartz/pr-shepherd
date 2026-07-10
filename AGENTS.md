# Code Standards

## Project Overview

PR Shepherd is a locally-hosted Node.js daemon that drives PRs through review/fix/merge workflows using Claude. The engine lives in `src/engine/`; step executors in `src/steps/`; data adapters in `src/db/`; workflow YAML definitions in `workflows/`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full layout and the [vision document (#1)](https://github.com/rmartz/pr-shepherd/issues/1) for the design rationale.

## Package Manager

- Always use `pnpm`. Never `npm` or `yarn`.
- **Pin full versions in `package.json`.** Every dependency version specifier must be a complete `major.minor.patch` (e.g. `^4.3.1`, `~26.0.0`, or an exact `19.2.7`) — never a truncated `^4` or `^19`. The range annotation (`^` / `~` / exact) is the author's choice; the **completeness** of the version is not. A truncated specifier lets a Dependabot minor/patch bump land with **no `package.json` change** (only a `pnpm-lock.yaml` change), hiding the update from the manifest and from reviewers — and a silent bump of a format-affecting tool like Prettier then surfaces only as a CI failure (cf. rmartz/trip-split#114). A full pin makes every accepted bump a visible `package.json` diff. When a Dependabot PR (or a manual bump) raises the resolved version, update the `package.json` floor to match.

## Common Commands

```bash
pnpm dev              # Start dev server (UI only, no engine)
pnpm build            # Production build
pnpm lint             # Lint
pnpm format           # Format
pnpm test             # Run tests with Vitest
pnpm tsc              # Type check
pnpm storybook        # Start Storybook dev server (port 6006)
pnpm build-storybook  # Build static Storybook
pnpm run env:validate # Validate deployment config files against schema
```

Pulling `.env.local`, pushing config to Vercel, and secret rotation are being
consolidated into a standalone `envctl` tool (usage TBD). Deployment config is
validated in CI via `.github/workflows/validate-config.yml`, whose schema also
hard-denies secret-like keys in the public `deployment/*.yml`.

The headless daemon (engine + step executors only — no HTTP surface) is launched via `shepherd start` once Epic 6 (CLI) lands. The UI is a separate Next.js app deployed to Vercel; it reads run state from Firestore via `onSnapshot`. See [ARCHITECTURE.md](ARCHITECTURE.md#deployment-topology) for the split.

## Worktree Setup

After creating a git worktree (`git worktree add .git-worktrees/`), run `pnpm install --frozen-lockfile` inside it before invoking any build, test, or lint commands. pnpm's `node-modules` linker creates per-directory `node_modules` trees; a fresh worktree has none. The global store is already populated so this step only creates hardlinks — it takes a few seconds and requires no network access.

## Deployment Config

Public (non-secret) environment config lives in `deployment/{env}.yml` and is validated against `deployment/schema.yml`. Only `NEXT_PUBLIC_*` and explicitly allowlisted keys are permitted; patterns matching `*SECRET*`, `*_TOKEN*`, or `*PRIVATE_KEY*` are hard-denied.

- To update a public config value (YAML only): `scripts/update-config.sh --env=<env> KEY=value`
- Validate the config files against the schema: `pnpm run env:validate`

Pushing config to Vercel (the old `--sync` flag / `sync-env`), pulling
`.env.local`, and secret rotation are being consolidated into a standalone
`envctl` tool (usage TBD); until it ships the `--sync` flag exits non-zero with
guidance. The config files themselves (`deployment/{env}.yml`, `schema.yml`)
remain and will be consumed by `envctl`. Deployment config is validated in CI via
`.github/workflows/validate-config.yml`, whose schema hard-denies secret-like
keys in the public `deployment/*.yml`.

## TypeScript

- Strict mode throughout. No `any` types. No `@ts-ignore`.
- Do not use `null` unless required for API compatibility or when explicitly distinguishing `null` from `undefined`. Prefer `undefined` for absent/optional values throughout the codebase.
- Prefer explicit `interface` names scoped to their component (e.g., `interface UserProfileCardProps` not `interface Props`).
- Use `async/await`, not `.then()` chains.

## File Organization

- **Source files**: Keep under ~200 lines (split at ~240). Large files should be split by logical concern.
- **Test files**: Keep under ~300 lines (split at ~360). Use `.spec.ts` / `.spec.tsx` extension (not `.test.ts`). When splitting, organize into a `{module}-tests/` directory with domain-specific files.
- **Hard cap (enforced)**: a `.ts`/`.tsx` file at +100% of the recommended limit — **400** lines for source, **600** for tests — fails the ESLint [`max-lines`](https://eslint.org/docs/latest/rules/max-lines) rule (`eslint.config.js`, `skipBlankLines`/`skipComments` off). It surfaces via `pnpm lint` in CI and `pre-push-verify.py`, and at commit time via lint-staged in the primary checkout. `git commit --no-verify` bypasses the local hook; CI's Lint job remains the backstop.
- **Components**: A component file contains its primary component and props interface. A sub-component may be co-located in the same file if it owns no hooks, state, effects, or context, and is used only by the parent component in that file — e.g., a context wrapper, structural template, or props alias. A sub-component must be in its own file when any of these are true: it owns hooks, state, effects, or context; it is referenced from multiple parents; or it is substantial enough to warrant its own stories or tests (e.g., list items, row components, panels, form sections). All component props must be defined as an explicitly named interface (e.g., `interface UserListProps`), never inline in the function signature.
- **Type files**: Convert large type files into barrel-exported directories with one file per logical domain.
- Add a barrel `index.ts` when a component or module directory exposes a public API or already
  follows a barrel pattern; do not require one for every directory (e.g. ShadCN-generated
  `src/components/ui/` has no barrel by convention).
- Use named exports, not default exports (except for Next.js pages and Storybook
  story files, where the only allowed default export is the required
  `export default meta`; stories and components must remain named exports).

## Code Conventions

- **Favor type inference.** Explicit generic type arguments (for example, `someFn<Foo>(...)`) are a code smell when TypeScript can infer them.
- **No spurious variables.** Do not assign a value to a variable only to immediately return it on the next line — return the expression directly instead.
- **No IIFEs.** Do not use immediately-invoked function expressions. Extract the logic into a named helper function or compute the value with a plain expression instead.
- **No function-style imports.** Do not use inline `import("…").Type` syntax in type annotations. Use module-level `import type { … } from "…"` statements at the top of the file. Dynamic `await import("…")` for services that require conditional loading (e.g., Sentry instrumentation) is acceptable.
- **No unnecessary helpers.** Do not extract logic into a helper function unless it separates significant logic or belongs in a different module. Three similar lines is better than a premature abstraction.
- **Enums and constant objects** should be kept in alphabetical order to minimize merge conflicts.
- **Value sets: default to a structural string union or `as const` array; reserve `enum` for internal-only sets (or seamed boundaries).** For a fixed set of named values the deciding axis is the **serialization boundary**. If the value crosses a wire/persistence boundary — a Firestore document, a GitHub label, a PR-comment marker, an API/query param — default to a **structural** type: a string union (`type MergeMethod = "merge" | "squash" | "rebase"`), or, when the values are also needed at runtime (validation/iteration), an `as const` array (`const X = [...] as const; type T = (typeof X)[number]`). Both stay structural, so raw/serialized strings assign without a cast and ~no runtime is emitted; a string `enum` is **nominal** (it rejects the underlying literal, forcing a cast at every boundary) and `const enum` is unavailable under `isolatedModules`. Reserve `enum` for **internal-only** state you iterate as a unit and never serialize raw — **or** for a boundary value already paired with an explicit serialization seam that centralizes the conversion (a Zod `z.enum(...)` schema, a `{domain}ToFirestore()` / `firestoreTo{domain}()` converter, or a narrowing type-predicate). Existing enums behind such a seam are deliberate — do not churn them. Keep members and values alphabetical (per the bullet above), and export new value-sets (structural or enum) from the module barrel when the barrel rule applies.

## Naming Conventions

- **Firestore schema conversions**: `{domain}ToFirestore()` / `firestoreTo{Domain}()`.
- **Workflow definitions**: One YAML file per workflow under `workflows/`, named after the workflow ID (e.g., `workflows/base-pr.yaml`).
- **Step executors**: One file per step type under `src/steps/`, camelCased (e.g., `claudeSkill.ts`, `waitCi.ts`, `githubApi.ts`).
- **Presentational views**: Components extracted for testability use the `{Component}View` suffix.

## User-Facing Text

- For any new or modified UI component, store user-facing strings in a co-located copy file
  (e.g., `ComponentName.copy.ts` or `copy.ts`) for internationalization (i18n) readiness.
  Do not introduce new hardcoded display strings inline in components you are actively changing.

  Existing hardcoded strings elsewhere in the codebase are technical debt to be migrated over
  time; this rule does not require unrelated cleanup.

- Copy files export a single `as const` object named `{SCOPE}_COPY` (e.g., `HOME_PAGE_COPY`, `USER_PROFILE_COPY`).

## Documentation

- Keep documentation in sync with the code — outdated docs are worse than no docs.
- **`docs/` follows the [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)**: one concept per markdown file with YAML frontmatter, cross-linked into a graph and listed in [docs/index.md](docs/index.md). These are pull/retrieval reference pages — **not** a place for always-in-context policy (that stays in this file / `CLAUDE.md`) or the top-level overview (`ARCHITECTURE.md`).
  - Every `docs/` page must start with frontmatter carrying a `type` from the vocabulary in [docs/index.md](docs/index.md) (`Subsystem`, `StepExecutor`, `Adapter`, `Workflow`, `Design`, `Reference`, `Index`, `Log`); `title`, `description`, `resource`, and `tags` are recommended. `scripts/check-docs-okf.mjs` validates this.
  - When you add a new subsystem, step executor, adapter, or workflow, add a corresponding `docs/` page and link it from `docs/index.md`.

## React / Next.js Standards

### Framework

- Next.js with App Router (not Pages Router).
- UI components: ShadCN UI. Do not install other component libraries.
- Styling: Tailwind CSS (comes with ShadCN). No CSS modules or styled-components.

### Client Components

- `"use client"` directive required on all React client components (Next.js App Router).
- React hooks must be called unconditionally — hooks before any early returns.

### JSX

- **No imperative logic inside JSX.** Imperative logic means anything that requires a statement rather than an expression: `const`/`let` declarations, `if`/`switch` blocks, loops, or any sequence of statements that produces a result through side effects. All such logic must live in the component body before the `return` statement, or be extracted into a child component. Expressions of any complexity are permitted directly in JSX — ternaries, logical operators (`&&`, `||`, `??`), method chains (`.map()`, `.filter()`, `.find()`), nested function calls, and template literals are all fine as long as they form a single expression with no intermediate bindings. Multi-statement callback functions passed as JSX props (e.g. `onChange={(e) => { setValue(e.target.value); setError(undefined); }}`) are permitted — the prohibition targets imperative logic in JSX structure, not callback bodies.

### Component Structure

- Components should have a single JSX return statement. Invalid states should be prevented by the type system or guarded against by the calling component. An early `return null` can be acceptable if the invalid state is infeasible for the parent component to detect, but the component itself should be returned as a single JSX block.

## Storybook

- Story files are co-located with their component: `ComponentName.stories.tsx`.
- When adding or modifying a UI component, add or update its Storybook story to cover key visual states.
- Stories should use mock data fixtures — never import from Firestore or depend on runtime providers (Zustand store, Next.js router, Firebase Auth context).
- Components that are too hook-dependent to render in isolation should use a presentational split: extract rendering into a `ComponentNameView` that accepts callbacks, and keep the original as a thin wrapper that wires up hooks.

## Component Tests

- Test files are co-located with their component: `ComponentName.spec.tsx`.
- When adding or modifying a UI component, add or update its test to verify rendering behavior and key prop-driven states.
- Use `@testing-library/react` with `vitest`. Always call `afterEach(cleanup)`.
- Do not use `.toBeInTheDocument()` — use `.toBeDefined()` or check `.textContent` instead.
- Assert against copy constants (e.g., `HOME_PAGE_COPY`) rather than hardcoded strings.
- Test presentational view components directly; avoid mocking hooks in tests where possible.

## Testing Conventions

- Use `describe`/`it` from Vitest (not `test`).
- Test fixture generators use `make{DomainName}()` (e.g., `makeUser()`, `makeSession()`).
- When splitting large test files, organize into `{module}-tests/` directories.

### Test Design

- **Control inputs and outputs.** Do not rely on a function's default return values as the assertion of a test unless the purpose of the test is specifically to verify those defaults. Use explicit, non-default values so a passing test proves the value was produced by logic, not inherited from an initializer.
- **One reason to fail per test.** Each test should assert a single logical outcome. Helper functions are fine, but if a test invokes two functions from the codebase it should be explicitly testing how those two interact. Incidental coverage of a second function is not a reason to combine assertions.
- **Keep tests simple.** A failing test should make it immediately obvious whether the failure is a bug or an intentional change in behavior. If understanding a failure requires reading more than one layer of test setup or multiple assertions, split the test.
- **Granularity scales with level of abstraction.** Low-level functions (pure utilities, serializers) warrant thorough edge-case coverage. High-level functions (service orchestration) should have smoke tests that verify they correctly apply the lower-level logic — not re-test every edge case that belongs in the lower-level tests.

## GitHub Issues

- When picking the next task from a milestone, use `gh issue list --milestone "<milestone title>" --state open`.

## Git Conventions

- Branch names: lowercase with hyphens. For issue-tracked work use the `/implement` skill convention `feat/issue-<number>-<slug>` (e.g., `feat/issue-42-add-workflow-loader`). For non-issue work prefix with `chore/`, `refactor/`, or `docs/` followed by a short description.
- Commit messages: imperative verbs (Add, Implement, Fix, Update, Extract, Remove). No `feat:`/`fix:` prefixes.
- PR titles must follow Conventional Commits format: `<type>: description` or `<type>(<scope>): description`. Valid types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `style`, `perf`, `ci`, `build`, `revert`. A `!` suffix is allowed before the colon to denote breaking changes (e.g., `feat!: remove legacy auth`). This is enforced by CI.
- PR descriptions must use `Closes #123`, `Fixes #123`, or `Resolves #123` to trigger GitHub's automatic issue close on merge. Phrases like "Addresses #123" or "Related to #123" do NOT trigger auto-close.
