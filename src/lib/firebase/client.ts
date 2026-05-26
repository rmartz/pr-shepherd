import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

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
// collections. See firestore.rules and ARCHITECTURE.md (#auth) for the model.
export function getClientAuth(): Auth {
  return getAuth(getClientApp());
}

// Firestore accessor — primary data store for the daemon.
export function getClientFirestore(): Firestore {
  return getFirestore(getClientApp());
}
