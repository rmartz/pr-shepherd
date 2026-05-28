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

// Firestore accessor — primary data store for the daemon.
//
// When `FIRESTORE_EMULATOR_HOST` is set (typically by the daemon's
// `createDb({ adapter: "firebase-emulator" })` flow), the returned
// Firestore handle is routed to the local emulator instead of the
// managed project. Real (production) calls leave the env var unset and
// hit the configured project as normal.
export function getClientFirestore(): Firestore {
  const fs = getFirestore(getClientApp());
  const host = process.env["FIRESTORE_EMULATOR_HOST"];
  if (host !== undefined && !emulatorConnected) {
    const [emulatorHost, portStr] = host.split(":");
    if (emulatorHost === undefined || portStr === undefined) {
      throw new Error(
        `FIRESTORE_EMULATOR_HOST must be in "host:port" format; got "${host}".`,
      );
    }
    const port = Number(portStr);
    if (!Number.isFinite(port)) {
      throw new Error(
        `FIRESTORE_EMULATOR_HOST port must be numeric; got "${portStr}".`,
      );
    }
    connectFirestoreEmulator(fs, emulatorHost, port);
    emulatorConnected = true;
  }
  return fs;
}
