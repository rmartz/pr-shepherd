# Technical Architecture Reference

This document captures non-business-logic technical decisions, patterns, and infrastructure setup for building a Next.js application with Firebase, Vercel, and high test coverage.

## Stack

| Layer           | Technology                      | Purpose                                                            |
| --------------- | ------------------------------- | ------------------------------------------------------------------ |
| Framework       | Next.js (App Router)            | Fullstack React with SSR/API routes                                |
| Language        | TypeScript (strict mode)        | Type safety throughout                                             |
| Package Manager | pnpm                            | Fast, disk-efficient dependency management                         |
| UI Components   | ShadCN UI + Tailwind CSS        | Composable, accessible component primitives                        |
| State (server)  | TanStack Query                  | Server state caching, polling, invalidation                        |
| State (client)  | Redux Toolkit                   | Local UI state (forms, config panels)                              |
| Database        | Firebase RTDB or Firestore      | Project's choice; both scaffolded with rules, accessors, and hooks |
| Auth            | Firebase Admin SDK (server)     | Session-based auth via API routes                                  |
| Hosting         | Vercel                          | Deployment, preview URLs, edge functions                           |
| Testing         | Vitest + @testing-library/react | Unit, component, and integration tests                             |
| Visual Testing  | Storybook 10                    | Component development and visual documentation                     |
| CI/CD           | GitHub Actions                  | Lint, format, test, build on every PR                              |
| Monitoring      | Sentry                          | Error tracking (client + server + edge)                            |

## Project Structure

```
project-root/
├── src/
│   ├── app/                    # Next.js App Router pages and API routes
│   │   ├── page.tsx            # Home page
│   │   ├── [dynamic]/          # Dynamic route segments
│   │   └── api/                # API route handlers
│   ├── components/
│   │   ├── ui/                 # ShadCN UI primitives (auto-generated, excluded from lint/prettier)
│   │   ├── {feature}/          # Feature-specific components with co-located stories and tests
│   │   └── {shared}/           # Shared components
│   ├── lib/
│   │   ├── firebase/           # Firebase Admin + client SDK wrappers
│   │   │   ├── admin.ts        # Server-side Firebase Admin initialization
│   │   │   ├── client.ts       # Client-side Firebase SDK initialization
│   │   │   └── schema/         # TypeScript types and serialization helpers
│   │   ├── types/              # Core domain types (barrel-exported)
│   │   └── utils.ts            # Shared utility functions (e.g., cn() for Tailwind)
│   ├── server/
│   │   ├── types/              # API response types (public-facing)
│   │   └── utils/              # Server-only helpers (auth, validation)
│   ├── services/               # Data access layer (Firebase-backed)
│   ├── hooks/                  # Custom React hooks (barrel-exported)
│   ├── store/                  # Redux Toolkit slices
│   └── test-setup/             # Vitest setup files (mocks, globals)
├── .storybook/                 # Storybook configuration
├── .github/
│   ├── actions/setup/          # Composite action: pnpm + Node.js + install
│   └── workflows/              # CI workflows
├── docs/                       # Feature documentation
├── package.json
├── tsconfig.json
├── next.config.ts
├── vitest.config.mts
├── eslint.config.js            # Flat config with typescript-eslint + react-hooks + storybook
├── postcss.config.mjs
└── .prettierignore
```

## Firebase Architecture

### Packages

- `firebase` (client SDK) — browser-side Firebase access
- `firebase-admin` (server SDK) — server-side Firebase access via API routes

### Choosing a Data Store

Projects built from this template should choose the data store that fits their needs. Both **Realtime Database (RTDB)** and **Firestore** are scaffolded with security rules, SDK accessors, and real-time subscription hooks. Pick one (or neither) and remove the scaffold for the other:

|                   | Realtime Database             | Firestore              |
| ----------------- | ----------------------------- | ---------------------- |
| Data model        | JSON tree                     | Document/collection    |
| Queries           | Path-based; limited filtering | Rich query support     |
| Real-time         | `onValue` push                | `onSnapshot` push      |
| Rules file        | `database.rules.json`         | `firestore.rules`      |
| Client accessor   | `getClientDatabase()`         | `getClientFirestore()` |
| Server accessor   | `getAdminDatabase()`          | `getAdminFirestore()`  |
| Subscription hook | `useRealtimeValue`            | `useFirestoreDocument` |

Remove `FIREBASE_DATABASE_URL` / `NEXT_PUBLIC_FIREBASE_DATABASE_URL` from env and config if not using RTDB.

### Initialization

Both SDKs are lazily initialized to avoid errors during static builds (CI has no env vars). `src/lib/firebase/client.ts` and `src/lib/firebase/admin.ts` expose product-specific accessors — call the one for your chosen data store:

```typescript
// Realtime Database
import { getClientDatabase } from "@/lib/firebase/client";
import { ref } from "firebase/database";
const userRef = ref(getClientDatabase(), `users/${uid}`);

// Firestore
import { getClientFirestore } from "@/lib/firebase/client";
import { doc } from "firebase/firestore";
const userDoc = doc(getClientFirestore(), "users", uid);
```

Product instances should be accessed via function calls, never module-level constants.

### Real-Time Subscription Hooks

Use the scaffolded hooks to subscribe to data and keep TanStack Query's cache in sync:

```typescript
// Realtime Database
import { useRealtimeValue } from "@/hooks";
import { ref } from "firebase/database";
import { getClientDatabase } from "@/lib/firebase/client";

const userRef = useMemo(() => ref(getClientDatabase(), `users/${uid}`), [uid]);
const { data, isLoading } = useRealtimeValue(userRef, (s) => s.val() as User, [
  "users",
  uid,
]);

// Firestore
import { useFirestoreDocument } from "@/hooks";
import { doc } from "firebase/firestore";
import { getClientFirestore } from "@/lib/firebase/client";

const userDoc = useMemo(() => doc(getClientFirestore(), "users", uid), [uid]);
const { data, isLoading } = useFirestoreDocument(
  userDoc,
  (s) => s.data() as User | undefined,
  ["users", uid],
);
```

Pass a memoised ref and a stable `queryKey` to avoid redundant re-subscriptions. Mutations go through API routes (Admin SDK write) → Firebase push → hook updates cache automatically.

### RTDB Schema Pattern

When using Realtime Database, separate public and private data at the path level:

```
/{collection}/{id}/public    # World-readable data (client SDK subscribes here)
/{collection}/{id}/private   # Server-only data (Admin SDK only)
```

See `database.rules.json` for the corresponding default security rules.

### Firestore Schema Pattern

Firestore organises data as collections of documents. Use uid-scoped paths for per-user data:

```
/users/{uid}/          # User profile and settings
/{collection}/{id}/    # Domain data — define access rules per collection
```

See `firestore.rules` for the default deny-all scaffold with a uid-scoped example.

### Serialization Layer

- TypeScript types define the domain model
- `{domain}ToFirebase()` converts domain objects to Firebase-safe format (no `undefined` values)
- `firebaseTo{Domain}()` converts Firebase snapshots back to domain objects with defaults
- Boolean settings are always written explicitly (not sparse) and deserialized with `?? false`

### Firebase Emulator

`firebase.json` configures local emulators for Auth, RTDB, and Firestore. Run them during development and testing to avoid touching production data:

```bash
pnpm emulator
```

Point tests at the emulator by setting environment variables before running Vitest:

```bash
FIREBASE_DATABASE_EMULATOR_HOST=localhost:9000 \
FIRESTORE_EMULATOR_HOST=localhost:8080 \
pnpm test
```

### Environment Variables

| Variable                 | Side   | Description                                    |
| ------------------------ | ------ | ---------------------------------------------- |
| `FIREBASE_PROJECT_ID`    | Server | Firebase project ID                            |
| `FIREBASE_CLIENT_EMAIL`  | Server | Service account email                          |
| `FIREBASE_PRIVATE_KEY`   | Server | Service account key (literal `\n`)             |
| `FIREBASE_DATABASE_URL`  | Server | RTDB URL (omit if using Firestore only)        |
| `NEXT_PUBLIC_FIREBASE_*` | Client | Client SDK config (API key, auth domain, etc.) |

`NEXT_PUBLIC_` variables are bundled into client JavaScript — this is by design. Access control is enforced by Firebase security rules, not by hiding these keys.

## Vitest Configuration

Three test projects in `vitest.config.mts`:

```typescript
{
  test: {
    projects: [
      {
        // Unit tests (actions, services, utilities)
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

The file extension convention (`.spec.ts` vs `.spec.tsx`) determines which project runs each test. This keeps the split automatic — no manual tagging or directory-based routing needed.

### Test File Conventions

- Co-located with source: `Component.spec.tsx`, `utility.spec.ts`
- Component tests use `@testing-library/react` with `afterEach(cleanup)`
- No jest-dom matchers — use `.toBeDefined()` or `.textContent`
- Test fixtures use `make{Domain}()` factory functions
- Large test files split into `{module}-tests/` directories

## Storybook Configuration

### Setup

- Framework: `@storybook/nextjs-vite`
- Addons: `addon-a11y`, `addon-docs`, `eslint-plugin-storybook`
- Tailwind loaded via `globals.css` import in `.storybook/preview.ts`

### Conventions

- Stories co-located as `ComponentName.stories.tsx`
- Presentational split for hook-dependent components: `{Component}View` accepts callbacks
- Mock data fixtures — no Firebase, no providers
- ESLint: strict TS rules relaxed for `.stories.tsx`; `.storybook/` and `storybook-static/` ignored

### Future Evaluation

- Chromatic for visual regression testing
- `@storybook/addon-vitest` for story-based integration testing
- `@storybook/addon-onboarding` — interactive first-launch walkthrough. Low value for solo/small-team projects where conventions are documented in AGENTS.md. May be useful for projects with frequent new contributors who need to learn the story writing workflow.

## ESLint Configuration

Flat config (`eslint.config.js`) with:

- `typescript-eslint` strict + stylistic type-checked rules for `src/**/*.{ts,tsx}`
- `react-hooks` plugin (rules-of-hooks + exhaustive-deps as errors)
- `eslint-plugin-storybook` flat/recommended
- Relaxed rules for test files (`*.test.ts`) and story files (`*.stories.tsx`)
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
| Job | Command | Purpose |
|---|---|---|
| Tests | `pnpm test` | Vitest across all projects |
| Lint | `pnpm lint` | ESLint with zero warnings |
| Format | `pnpm format:check` | Prettier check |
| Build | `pnpm build` | Next.js production build |

**Claude Code** (`issue_comment`, `pull_request_review_comment`, `issues`): Optional — runs Claude Code action when `@claude` is mentioned in issues/PRs. Requires `ANTHROPIC_API_KEY` secret.

### Vercel

- Automatic preview deployments on every PR
- Production deployment on merge to main
- Root directory: project root (no subdirectory)

## Service Layer Pattern

### Separation of Concerns

```
API Route → Service (data access) → Firebase
```

- **Services**: Pure data access — read/write Firebase. No business logic.
- **Business logic modules**: Domain-specific logic separated from data access.

### Service Conventions

- Service functions accept and return typed interfaces, never raw Firebase snapshots
- Timestamps converted to `Date` objects at the service boundary
- Each domain gets its own service file or directory
- Components never import Firebase directly — all data access goes through services or hooks

## State Management

### Server State (TanStack Query)

- Data fetched via `useQuery` with Firebase `onValue` for real-time push
- Mutations via `useMutation` → API routes → Firebase Admin SDK
- Cache invalidation on successful mutation

### Client State (Redux Toolkit)

- Used for local UI state only (forms, config panels)
- Slices in `store/{feature}-slice.ts`
- Connected to components via `useAppSelector` / `useAppDispatch`

### Providers Pattern

A client boundary component wraps the app with all required providers:

```
Root Layout → Providers ("use client") → QueryClientProvider → AuthProvider → Pages
```

`QueryClient` is created via `useState` inside the Providers component to avoid re-creation on re-renders.

### Real-Time Pattern

```
Firebase RTDB push → onValue callback → TanStack Query cache update → React re-render
```

No polling needed for subscribed paths. Mutations go through API routes, which write to Firebase, which triggers the push.

## Authentication Pattern

The template uses Firebase Auth with server-side session cookies for SSR compatibility.

### AuthProvider → useAuth() contract

`AuthProvider` (`src/components/auth/AuthProvider.tsx`) subscribes to `onAuthStateChanged` and exposes `{ user: User | null, loading: boolean }` via React context. Components and hooks access this via `useAuth()` from `src/hooks/use-auth.ts` — never import Firebase Auth directly in components.

### Session cookie flow

1. User signs in via `signIn()` / `signUp()` from `src/services/auth.ts`
2. Client calls `user.getIdToken()` and POSTs it to `POST /api/auth/session`
3. The server calls `getAdminAuth().createSessionCookie()` and sets an `HttpOnly`, `Secure`, `SameSite=Strict` cookie
4. Middleware (`src/middleware.ts`) verifies the cookie on every request via `getAdminAuth().verifySessionCookie(cookie, true)` and redirects unauthenticated requests to `/sign-in?next=<path>`
5. On sign-out, call `DELETE /api/auth/session` to clear the cookie, then call `signOut()` from the auth service

The middleware runs in the Node.js runtime (not Edge) because `firebase-admin` does not support the Edge runtime.

### Adding SSO providers (Google, Apple, etc.)

Adding a provider requires only client-side changes — no server modifications needed. Add a function to `src/services/auth.ts` and call it from the component:

```typescript
// src/services/auth.ts
import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";

export async function signInWithGoogle() {
  const credential = await signInWithPopup(
    getClientAuth(),
    new GoogleAuthProvider(),
  );
  await createSession(await credential.user.getIdToken());
}

// In your component:
import { signInWithGoogle } from "@/services/auth";
await signInWithGoogle();
```

### Scoping data to the authenticated user

The verified session cookie decoded by `verifySessionCookie()` contains `uid`. Use this to scope all database reads and writes to the authenticated user's paths.

## Key Packages

### Dependencies

| Package                                                | Purpose                              |
| ------------------------------------------------------ | ------------------------------------ |
| `next`                                                 | Fullstack React framework            |
| `react` / `react-dom`                                  | UI rendering                         |
| `@reduxjs/toolkit` / `react-redux`                     | Client state management              |
| `@tanstack/react-query`                                | Server state management              |
| `firebase`                                             | Client SDK (real-time subscriptions) |
| `firebase-admin`                                       | Server SDK (data mutations)          |
| `@sentry/nextjs`                                       | Error tracking                       |
| `@vercel/analytics`                                    | Usage analytics                      |
| `class-variance-authority` / `clsx` / `tailwind-merge` | ShadCN UI utilities                  |
| `lucide-react`                                         | Icons                                |

### Dev Dependencies

| Package                                                                                  | Purpose                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `typescript`                                                                             | Type checking                                  |
| `vitest` / `@testing-library/react` / `happy-dom`                                        | Testing                                        |
| `storybook` / `@storybook/nextjs-vite`                                                   | Component development                          |
| `eslint` / `typescript-eslint` / `eslint-plugin-react-hooks` / `eslint-plugin-storybook` | Linting                                        |
| `prettier`                                                                               | Formatting                                     |
| `prettier-plugin-tailwindcss`                                                            | Automatic Tailwind class sorting (recommended) |
| `husky` / `lint-staged`                                                                  | Pre-commit hooks                               |
| `tailwindcss` / `@tailwindcss/postcss` / `postcss`                                       | Styling                                        |
| `shadcn`                                                                                 | ShadCN UI CLI                                  |

## Initialization Checklist

When starting a new project from this template:

1. Click "Use this template" on GitHub
2. Clone the new repository and run `pnpm install`
3. Copy `.env.example` to `.env.local` and fill in Firebase credentials
4. Configure Firebase project + environment variables
5. Set up Vercel project with GitHub integration
6. Add `ANTHROPIC_API_KEY` secret to GitHub repository settings (for Claude Code workflow)
7. Update `AGENTS.md` / `CLAUDE.md` with project-specific conventions
