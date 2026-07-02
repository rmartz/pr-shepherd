import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// `gh` CLI invocation seam (issue #290).
//
// The production GitHub transports shell out to the `gh` CLI (already the
// daemon's auth + API surface everywhere else). `GhExec` is the injectable that
// runs one `gh` invocation and returns its raw result; production uses
// `defaultGhExec` (a real `gh` subprocess), tests inject a fake returning
// scripted stdout/stderr/exit codes — so the transports are unit-testable
// without a network or a real `gh`.
// ---------------------------------------------------------------------------

export interface GhCommand {
  // Arguments passed to `gh` (the `gh` binary itself is implicit).
  args: string[];
  // Optional request body written to the subprocess's stdin (e.g. a GraphQL
  // `{ query, variables }` payload passed via `--input -`).
  stdin?: string;
}

export interface GhResult {
  stdout: string;
  stderr: string;
  // The process exit code; `1` when the process died on a signal with no code.
  exitCode: number;
}

export type GhExec = (command: GhCommand) => Promise<GhResult>;

// Run a real `gh` subprocess. Inherits the ambient environment (so `gh`'s
// existing auth applies) and never uses a shell (args are passed as an array,
// so there is no command-injection surface).
export function defaultGhExec(command: GhCommand): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", command.args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    // `error` fires when the binary can't be spawned at all (e.g. `gh` not on
    // PATH) — a hard failure distinct from a non-zero exit.
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    if (command.stdin !== undefined) {
      child.stdin.write(command.stdin);
      child.stdin.end();
    }
  });
}

// Rate-limit markers `gh` prints to stderr on a primary (HTTP 429 / 403 with a
// reset) or secondary rate-limit rejection. The transports translate a match
// into a `GithubRateLimitError` so the derivation retry layer engages its
// backoff (any other error bypasses the retry — see the GithubReadTransport
// contract, #140).
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate limit/i,
  /secondary rate/i,
  /submitted too quickly/i,
  /too many requests/i,
  /\b429\b/,
];

export function isRateLimitResult(result: GhResult): boolean {
  return (
    result.exitCode !== 0 &&
    RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(result.stderr))
  );
}
