import { NotImplementedError } from "./types";

// Handler for `shepherd status`.
//
// Scaffold only. A later issue gives this a thin Firestore-reading
// implementation that summarizes active runs and the daemon's health.
export async function runStatus(): Promise<void> {
  await Promise.resolve();
  throw new NotImplementedError("status");
}
