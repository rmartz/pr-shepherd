---
type: Reference
title: Local Development
description: Run the PR Shepherd daemon against a local Firebase Emulator instead of managed Firestore.
tags: [setup, firebase, emulator]
---

# Local Development

This page covers running the PR Shepherd daemon against a local Firebase Emulator instead of a managed Firestore project. Use this for end-to-end testing without burning a Firebase quota or touching production data.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the deployment topology and [vision issue #1](https://github.com/rmartz/pr-shepherd/issues/1) for design context.

## Prerequisites

- Node.js 24+ (the project's pinned LTS)
- `pnpm` (see [CLAUDE.md](../CLAUDE.md))
- Java JDK 11+ (the Firebase Emulator Suite is a Java app)
- `firebase-tools` CLI: `npm install -g firebase-tools` (or `pnpm add -g firebase-tools`)

## Start the emulator

From the repo root:

```bash
firebase emulators:start --only firestore
```

The Firestore emulator binds to `localhost:8080` by default. The Emulator UI is available at `http://localhost:4000`.

Leave the emulator running in its own terminal. State is in-memory by default; pass `--import=./emulator-data --export-on-exit` to persist data across restarts.

## Point the daemon at the emulator

In your `config.yaml` (copy from `config.example.yaml`):

```yaml
db:
  adapter: firebase-emulator
  emulator:
    firestoreHost: localhost:8080
```

The daemon (`shepherd start`) sets `FIRESTORE_EMULATOR_HOST` on its own process at startup, which the **firebase-admin SDK reads natively** and uses to route every collection/doc/query call to the emulator.

The adapter class is the same `HostedFirestoreDb` used in production — only the underlying SDK destinations change. This is why the integration tests in `src/db/adapters/hostedFirestore.integration.spec.ts` exercise the production code path end-to-end against the emulator.

## Point the UI at the emulator

The Vercel UI is a Next.js client bundle. Browsers cannot read `config.yaml` and cannot read non-`NEXT_PUBLIC_*` env vars at runtime, so the daemon's env-var write does NOT reach the UI. For local UI dev against the emulator, set the public-prefixed variable in `.env.local` at the repo root:

```env
# .env.local — read by `pnpm dev` and inlined into the client bundle
NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST=localhost:8080
```

When that variable is present, `getClientFirestore()` (in `src/lib/firebase/client.ts`) calls `connectFirestoreEmulator(firestore, host, port)` on first use. The unprefixed `FIRESTORE_EMULATOR_HOST` is honored as a fallback for SSR and Node test contexts but does not reach the browser bundle.

Production (Vercel) leaves both variables unset; the UI hits the configured managed Firestore project as normal.

## Run the daemon

Once Epic 6's CLI ships:

```bash
shepherd start
```

Until then, integration tests are the easiest way to exercise the emulator path. From the repo root:

```bash
FIRESTORE_EMULATOR_HOST=localhost:8080 \
FIREBASE_PROJECT_ID=demo-pr-shepherd-emulator \
pnpm test src/db/adapters/hostedFirestore.integration.spec.ts
```

The test reports as **skipped** (not passed) when the emulator is unreachable, so a missing emulator never gives a false-positive green run.

## Verify in the Emulator UI

Open `http://localhost:4000/firestore` while the daemon (or integration tests) write. You should see:

- A `repositories` collection with documents the daemon enrolls.
- A `workflowRuns` collection populated as runs progress.
- A `stepInstances` collection populated as the scheduler dispatches steps.
- A `_meta` collection holding one document per managed collection recording the latest applied migration version (see `src/db/migrations/`).

## Switching back to hosted Firestore

Edit `config.yaml` back to `adapter: firebase-hosted` — the daemon clears `FIRESTORE_EMULATOR_HOST` on every non-emulator `createDb` call, so adapter selection is deterministic across restarts.

For the UI, remove (or comment out) `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST` from `.env.local` and restart `pnpm dev` so the new value is inlined into the bundle.

The `emulator:` block in `config.yaml` is ignored when the adapter is anything other than `firebase-emulator`, so it can stay in the file as documentation.

## Troubleshooting

- **`FIRESTORE_EMULATOR_HOST is set but the emulator is not running`** — the admin SDK will throw on the first read/write. Start `firebase emulators:start` and retry.
- **Permission denied on `workflowDefinitions` reads from the UI** — the deployed `firestore.rules` grants client reads for all four daemon collections via `isAllowedOperator()`. When running against the emulator, the rules are still evaluated; sign in via the Auth emulator with an allowlisted email or temporarily relax `firestore.rules` for local-only use.
- **`connectFirestoreEmulator: emulator can no longer be connected after a Firestore instance has been used`** — the connect call must happen before any read/write on the Firestore handle. `getClientFirestore()` calls it on first use; if you have other code that calls `getFirestore()` directly before going through `getClientFirestore()`, route everything through the latter.
