import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env["NEXT_PUBLIC_FIREBASE_API_KEY"],
  authDomain: process.env["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"],
  projectId: process.env["NEXT_PUBLIC_FIREBASE_PROJECT_ID"],
};

export function getClientApp(): FirebaseApp {
  return (
    getApps().find((a) => a.name === "[DEFAULT]") ??
    initializeApp(firebaseConfig)
  );
}

// Auth accessor — used by the Vercel-hosted UI to gate access to Firestore
// reads. Firebase Auth tokens populate `request.auth` in `firestore.rules`,
// where an email allowlist further restricts who can read the daemon
// collections. See `firestore.rules` (`isAllowedOperator()`) for the model.
export function getClientAuth(): Auth {
  return getAuth(getClientApp());
}

// Module-level latch so `connectFirestoreEmulator` is only ever called
// once per Firestore instance. The Firebase client SDK throws if you
// invoke it a second time on the same instance.
let emulatorConnected = false;

interface EmulatorHostPort {
  host: string;
  port: number;
}

// Parse and validate a Firestore emulator `host:port` string. Rejects
// missing parts, empty values, multi-colon inputs, and out-of-range
// ports so a misconfiguration surfaces as a clear error rather than a
// connection to a useless address (e.g. port 0 from `localhost:`).
function parseEmulatorHostPort(raw: string): EmulatorHostPort {
  const parts = raw.split(":");
  if (parts.length !== 2) {
    throw new Error(
      `Firestore emulator host must be exactly "host:port"; got "${raw}".`,
    );
  }
  const [host, portStr] = parts;
  if (
    host === undefined ||
    portStr === undefined ||
    host.length === 0 ||
    portStr.length === 0
  ) {
    throw new Error(
      `Firestore emulator host must have non-empty host and port; got "${raw}".`,
    );
  }
  if (!/^\d+$/.test(portStr)) {
    throw new Error(
      `Firestore emulator port must be a non-negative integer; got "${portStr}".`,
    );
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Firestore emulator port must be in 1..65535; got "${portStr}".`,
    );
  }
  return { host, port };
}

// Resolve the emulator host from env vars. The client SDK runs in the
// browser at runtime, so it must read a `NEXT_PUBLIC_*` variable —
// Next.js only inlines `process.env.*` references at build time for
// variables with that prefix, and only those values reach the browser
// bundle. The unprefixed `FIRESTORE_EMULATOR_HOST` is supported as a
// fallback for server-side rendering, the daemon (Node process), and
// Vitest's node test environment.
function readEmulatorHost(): string | undefined {
  return (
    process.env["NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST"] ??
    process.env["FIRESTORE_EMULATOR_HOST"]
  );
}

// Firestore accessor — primary data store for the daemon.
//
// When the emulator host env var is set (typically by the daemon's
// `createDb({ adapter: "firebase-emulator" })` flow on the server side,
// or by `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST` in `.env.local` on the UI
// side), the returned Firestore handle is routed to the local emulator
// instead of the managed project. Production calls leave both env vars
// unset and hit the configured project as normal.
export function getClientFirestore(): Firestore {
  const fs = getFirestore(getClientApp());
  const raw = readEmulatorHost();
  if (raw !== undefined && !emulatorConnected) {
    const { host, port } = parseEmulatorHostPort(raw);
    connectFirestoreEmulator(fs, host, port);
    emulatorConnected = true;
  }
  return fs;
}
