import { NotImplementedError } from "./types";

// Handler for `shepherd force-retry <runId>`.
//
// Scaffold only. A later issue gives this a thin Firestore-writing
// implementation that resets the named run so the scheduler re-dispatches
// it. The `runId` argument is already parsed and passed through by the
// commander wiring so that implementation only needs to fill the body.
export async function runForceRetry(runId: string): Promise<void> {
  await Promise.resolve();
  throw new NotImplementedError(`force-retry ${runId}`);
}
