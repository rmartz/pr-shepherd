import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

// ---------------------------------------------------------------------------
// Headless skill invocation for the dispatcher (issue #413).
//
// Unlike the `claude_skill` step executor, this does NOT scrub GitHub
// credentials: the dotfiles skills (/review, /fix-review, /merge) do their own
// `gh` / MCP writes. The skill runs with `cwd` set to the repo's root checkout,
// which is what those skills expect (they resolve the repo from the cwd).
// ---------------------------------------------------------------------------

export interface SkillRunRequest {
  claudeBin: string;
  // Extra CLI args placed before the prompt (e.g. `--model`, `--permission-mode`).
  claudeArgs: readonly string[];
  prompt: string;
  cwd: string;
  logFile: string;
  timeoutMs: number;
  // Aborting SIGTERMs the subprocess (then SIGKILLs after a grace period).
  signal?: AbortSignal;
}

export interface SkillRunResult {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

const KILL_GRACE_MS = 10_000;

// `--` terminates option parsing so a variadic flag in `claudeArgs`
// (e.g. `--allowedTools`) cannot swallow the prompt (cf. rmartz/dotfiles#140).
export function buildClaudeArgv(
  claudeArgs: readonly string[],
  prompt: string,
): string[] {
  return ["-p", ...claudeArgs, "--", prompt];
}

export function runSkill(request: SkillRunRequest): Promise<SkillRunResult> {
  const startedAt = Date.now();
  const log = createWriteStream(request.logFile, { flags: "a" });
  const child = spawn(
    request.claudeBin,
    buildClaudeArgv(request.claudeArgs, request.prompt),
    { cwd: request.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);
  request.signal?.addEventListener("abort", terminate, { once: true });

  return new Promise((resolve) => {
    // `error` (spawn failure) can be followed by `close`; settle only once.
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", terminate);
      log.end();
      resolve({ exitCode, timedOut, durationMs: Date.now() - startedAt });
    };
    child.on("error", (error) => {
      log.write(`\n[dispatcher] failed to spawn: ${error.message}\n`);
      finish(127);
    });
    child.on("close", (code) => {
      finish(code ?? 1);
    });
  });
}
