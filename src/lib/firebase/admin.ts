import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getDatabase, type Database } from "firebase-admin/database";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

export function getAdminApp(): App {
  const existing = getApps().find((a) => a.name === "[DEFAULT]");
  if (existing) return existing;

  return initializeApp({
    credential: cert({
      projectId: process.env["FIREBASE_PROJECT_ID"],
      clientEmail: process.env["FIREBASE_CLIENT_EMAIL"],
      privateKey: process.env["FIREBASE_PRIVATE_KEY"]?.replace(/\\n/g, "\n"),
    }),
    // Required for Realtime Database; omit if using Firestore only.
    databaseURL: process.env["FIREBASE_DATABASE_URL"],
  });
}

// Realtime Database accessor — use when RTDB is the project's data store.
export function getAdminDatabase(): Database {
  return getDatabase(getAdminApp());
}

// Firestore accessor — use when Firestore is the project's data store.
export function getAdminFirestore(): Firestore {
  return getFirestore(getAdminApp());
}
