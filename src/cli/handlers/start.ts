import { NotImplementedError } from "./types";

// Handler for `shepherd start`.
//
// Scaffold only: the real engine bootstrap (load config, connect the
// Firestore admin SDK, start the scheduler + commands listener, install
// the SIGTERM drain) lands in the daemon-bootstrap follow-up (#207).
// Keeping it a standalone module means that issue can fill this in
// without touching the commander wiring in `src/cli/program.ts`.
export async function runStart(): Promise<void> {
  await Promise.resolve();
  throw new NotImplementedError("start");
}
