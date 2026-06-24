import { spawn as nodeSpawn } from "node:child_process";
import { z } from "zod";
import { Collections } from "@/db/collections";
import type { StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";
import type { ExecutorResult, StepExecutor } from "@/engine/runner";
import { parseSkillOutput } from "./parseSkillOutput";

// ---------------------------------------------------------------------------
// `claude_skill` step executor (Epic 4, #61).
//
// Spawns a `claude` subprocess for the step's skill, streams its output into
// the step's `logs`, heartbeats while it runs (so the heartbeat monitor #58
// can catch a hung subprocess), and returns the parsed response as the step
// output. On a non-zero exit it throws, which the runner records as a failed
// step.
//
// Capability-based isolation (hard rule, vision §4.3): the subprocess is
// spawned with `GITHUB_TOKEN`, `GH_TOKEN`, and any GitHub-MCP credential env
// vars **scrubbed**, so a Claude skill physically cannot call `gh` or a
// GitHub MCP tool. All GitHub mutation goes through the `github_api` queue —
// this structural guarantee is what makes the GitHub-API concurrency cap (#45)
// meaningful.
//
// `metrics.claudeMs` is intentionally NOT written here: the runner derives it
// from the step's running duration (`computeStepMetrics` maps a `claude_skill`
// step to `elapsed(startedAt, completedAt)`), which equals the subprocess
// wall-clock since the step is `running` for exactly the subprocess lifetime.
// Writing it here too would double-count via the runner's `addStepDelta`.
// ---------------------------------------------------------------------------

export const ClaudeSkillInputSchema = z.object({
  skill: z.string(),
  args: z.array(z.string()).default([]),
});
export type ClaudeSkillInput = z.infer<typeof ClaudeSkillInputSchema>;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_GRACE_MS = 5_000;

// Minimal slice of a spawned child process the executor relies on, so tests
// can inject a fake without a real subprocess.
export interface SpawnedStream {
  on: (event: "data", listener: (chunk: Buffer | string) => void) => void;
}
export interface SpawnedProcess {
  stdout: SpawnedStream | null;
  stderr: SpawnedStream | null;
  on: ((
    event: "close",
    listener: (code: number | null) => void | Promise<void>,
  ) => void) &
    ((event: "error", listener: (err: Error) => void) => void);
  kill: (signal?: NodeJS.Signals) => boolean;
}
export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined> },
) => SpawnedProcess;

export interface CreateClaudeSkillExecutorOptions {
  // Injected spawn for tests; defaults to `node:child_process.spawn` with
  // piped stdio and no shell (avoids command injection).
  spawn?: SpawnFn;
  // Command to spawn; defaults to "claude". Overridable so tests can spawn a
  // deterministic process (e.g. `printenv`) against the scrubbed env.
  command?: string;
  // Base environment to scrub + pass through; defaults to `process.env`.
  env?: Record<string, string | undefined>;
  now?: () => number;
  heartbeatIntervalMs?: number;
  graceMs?: number;
  // Aborting this signal SIGTERMs the subprocess, then SIGKILLs after grace.
  signal?: AbortSignal;
}

// Remove GitHub credentials from an env so the spawned skill cannot reach
// GitHub. Scrubs `GITHUB_TOKEN`, `GH_TOKEN`, and any var whose name contains
// both "MCP" and "GITHUB" (case-insensitive) — i.e. GitHub MCP server creds.
export function scrubGithubEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const scrubbed: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper === "GITHUB_TOKEN" || upper === "GH_TOKEN") continue;
    if (upper.includes("MCP") && upper.includes("GITHUB")) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined> },
): SpawnedProcess {
  return nodeSpawn(command, args, {
    // The dynamically-scrubbed env is a plain string map; the repo augments
    // NodeJS.ProcessEnv with required keys, so cast through unknown.
    env: options.env as unknown as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function toLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

export function createClaudeSkillExecutor(
  db: Db,
  options: CreateClaudeSkillExecutorOptions = {},
): StepExecutor {
  const spawnFn = options.spawn ?? defaultSpawn;
  const command = options.command ?? "claude";
  const baseEnv = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const signal = options.signal;

  return (step: StepInstance): Promise<ExecutorResult> => {
    const input = ClaudeSkillInputSchema.parse(step.input);
    const env = scrubGithubEnv(baseEnv);
    const child = spawnFn(command, [input.skill, ...input.args], { env });

    return new Promise<ExecutorResult>((resolve, reject) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const heartbeat = setInterval(() => {
        void db.update(Collections.stepInstances, step.id, {
          heartbeatAt: now(),
        });
      }, heartbeatIntervalMs);

      function onAbort(): void {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, graceMs);
      }

      function cleanup(): void {
        clearInterval(heartbeat);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      }

      child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
      child.stderr?.on("data", (chunk) => stderrChunks.push(chunk.toString()));

      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      child.on("close", async (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        const stdout = stdoutChunks.join("");
        const stderr = stderrChunks.join("");
        const logs = [...toLines(stdout), ...toLines(stderr)];
        // Persist streamed logs before settling — the runner's terminal write
        // sets status/output/metrics but not logs, so this is the only place
        // they land.
        try {
          await db.update(Collections.stepInstances, step.id, { logs });
          if (code === 0) {
            resolve({ output: parseSkillOutput(stdout) });
          } else {
            reject(
              new Error(
                `claude subprocess exited with code ${String(code)}: ${stderr.trim().slice(-200)}`,
              ),
            );
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  };
}
