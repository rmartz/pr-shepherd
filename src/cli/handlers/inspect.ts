import { NotImplementedError } from "./types";

// Handler for `shepherd inspect <runId>`.
//
// Scaffold only. A later issue gives this a thin Firestore-reading
// implementation that prints the named run's context, current step, and
// step history. The `runId` argument is already parsed and passed through
// by the commander wiring.
export async function runInspect(runId: string): Promise<void> {
  await Promise.resolve();
  throw new NotImplementedError(`inspect ${runId}`);
}
