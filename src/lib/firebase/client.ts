import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getDatabase, type Database } from "firebase/database";
import { getFirestore, type Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env["NEXT_PUBLIC_FIREBASE_API_KEY"],
  authDomain: process.env["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"],
  projectId: process.env["NEXT_PUBLIC_FIREBASE_PROJECT_ID"],
  // Required for Realtime Database; omit if using Firestore only.
  databaseURL: process.env["NEXT_PUBLIC_FIREBASE_DATABASE_URL"],
};

export function getClientApp(): FirebaseApp {
  return (
    getApps().find((a) => a.name === "[DEFAULT]") ??
    initializeApp(firebaseConfig)
  );
}

// Realtime Database accessor — use when RTDB is the project's data store.
export function getClientDatabase(): Database {
  return getDatabase(getClientApp());
}

// Firestore accessor — use when Firestore is the project's data store.
export function getClientFirestore(): Firestore {
  return getFirestore(getClientApp());
}
