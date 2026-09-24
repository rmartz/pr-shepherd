import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { GhExec } from "@/github/ghExec";
import type { DispatchRule } from "./rules";
import { buildSearchQuery } from "./rules";
import type { SkillRunRequest, SkillRunResult } from "./runner";
import { searchPullRequests } from "./search";
import type { AttemptRecord, DispatchCandidate } from "./select";
import { assignRules, recordAttempt, selectJobs } from "./select";

// ---------------------------------------------------------------------------
// The dispatcher poll loop (issue #413): search → select → spawn, repeated.
// All state (running jobs, attempt history) is in memory; restarting the
// dispatcher clears stall/cooldown guards, which is the intended manual reset.
// ---------------------------------------------------------------------------

const MIN_POLL_GAP_MS = 15_000;

export interface DispatcherOptions {
  rules: readonly DispatchRule[];
  owner?: string;
  reposRoot: string;
  logDir: string;
  concurrency: number;
  intervalMs: number;
  timeoutMs: number;
  cooldownMs: number;
  maxAttempts: number;
  claudeBin: string;
  claudeArgs: readonly string[];
  once: boolean;
  dryRun: boolean;
}

export interface DispatcherDeps {
  gh: GhExec;
  runSkill: (request: SkillRunRequest) => Promise<SkillRunResult>;
  log: (message: string) => void;
  now: () => number;
  // Aborting stops scheduling new jobs; running jobs are left to finish.
  stop: AbortSignal;
  // Aborting kills running jobs.
  kill: AbortSignal;
}

async function findCandidates(
  options: DispatcherOptions,
  deps: DispatcherDeps,
): Promise<DispatchCandidate[]> {
  const results = await Promise.all(
    options.rules.map(async (rule) => ({
      rule,
      hits: await searchPullRequests(
        deps.gh,
        buildSearchQuery(rule, options.owner),
      ),
    })),
  );
  return assignRules(results);
}

export async function runDispatcher(
  options: DispatcherOptions,
  deps: DispatcherDeps,
): Promise<void> {
  const running = new Map<string, Promise<void>>();
  const history = new Map<string, AttemptRecord>();
  // Log each missing checkout / stalled PR once, not every cycle.
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    deps.log(message);
  };
  mkdirSync(options.logDir, { recursive: true });

  const launch = (candidate: DispatchCandidate, cwd: string) => {
    const prompt = `${candidate.rule.skill} ${String(candidate.number)}`;
    const logFile = path.join(
      options.logDir,
      `${candidate.repoName}-${String(candidate.number)}-${candidate.rule.skill.slice(1)}-${String(deps.now())}.log`,
    );
    deps.log(
      `start  ${candidate.key} ${prompt} (${candidate.rule.name}) → ${logFile}`,
    );
    // `running.set` below runs before the first await here resolves, so the
    // `finally` delete always follows it.
    const runJob = async () => {
      try {
        const result = await deps.runSkill({
          claudeBin: options.claudeBin,
          claudeArgs: options.claudeArgs,
          prompt,
          cwd,
          logFile,
          timeoutMs: options.timeoutMs,
          signal: deps.kill,
        });
        const outcome = result.timedOut
          ? "timed out"
          : `exit ${String(result.exitCode)}`;
        deps.log(
          `finish ${candidate.key} ${prompt}: ${outcome} in ${String(Math.round(result.durationMs / 1000))}s`,
        );
      } catch (error) {
        deps.log(
          `error  ${candidate.key} ${prompt}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        recordAttempt(history, candidate, deps.now());
        running.delete(candidate.key);
      }
    };
    running.set(candidate.key, runJob());
  };

  while (!deps.stop.aborted) {
    let candidates: DispatchCandidate[] = [];
    try {
      candidates = await findCandidates(options, deps);
    } catch (error) {
      deps.log(
        `search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const dispatchable = candidates.filter((candidate) => {
      const cwd = path.join(options.reposRoot, candidate.repoName);
      if (existsSync(path.join(cwd, ".git"))) return true;
      warnOnce(
        `checkout:${candidate.repo}`,
        `skip   ${candidate.repo}: no local checkout at ${cwd}`,
      );
      return false;
    });

    const { jobs, skipped } = selectJobs({
      candidates: dispatchable,
      running: new Set(running.keys()),
      history,
      now: deps.now(),
      // A dry run lists everything dispatchable, not just one batch.
      slots: options.dryRun
        ? Number.POSITIVE_INFINITY
        : options.concurrency - running.size,
      cooldownMs: options.cooldownMs,
      maxAttempts: options.maxAttempts,
    });
    for (const { candidate, reason } of skipped) {
      if (reason === "stalled") {
        warnOnce(
          `stalled:${candidate.key}:${candidate.headSha}:${candidate.rule.skill}`,
          `stall  ${candidate.key}: ${candidate.rule.skill} ran ${String(options.maxAttempts)}x on ${candidate.headSha.slice(0, 7)} without the label moving — skipping until the head or label changes`,
        );
      }
    }
    for (const candidate of jobs) {
      if (options.dryRun) {
        deps.log(
          `would  ${candidate.key} ${candidate.rule.skill} ${String(candidate.number)} (${candidate.rule.name})`,
        );
      } else {
        launch(candidate, path.join(options.reposRoot, candidate.repoName));
      }
    }

    if (options.once) break;
    // Wake on the interval, when any job finishes (a slot opened), or on stop.
    await Promise.race([
      sleep(options.intervalMs, undefined, { signal: deps.stop }).catch(
        () => undefined,
      ),
      ...running.values(),
    ]);
    // Floor between polls so a burst of fast-failing jobs can't spin the
    // search API.
    await sleep(MIN_POLL_GAP_MS, undefined, { signal: deps.stop }).catch(
      () => undefined,
    );
  }

  if (running.size > 0) {
    deps.log(`waiting for ${String(running.size)} running job(s) to finish…`);
    await Promise.all(running.values());
  }
}
