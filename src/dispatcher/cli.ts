#!/usr/bin/env -S npx tsx
import { homedir } from "node:os";
import path from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { defaultGhExec } from "@/github/ghExec";
import type { DispatcherOptions } from "./loop";
import { runDispatcher } from "./loop";
import { DISPATCH_RULES } from "./rules";
import { runSkill } from "./runner";

// ---------------------------------------------------------------------------
// `pnpm dispatch` — the label-driven, cross-repo PR dispatcher (issue #413).
// An interim stand-in for the dotfiles coordinator until the daemon ships.
// ---------------------------------------------------------------------------

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive number");
  }
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface DispatchCliOptions {
  owner: string;
  anyOwner: boolean;
  reposRoot: string;
  logDir: string;
  concurrency: number;
  interval: number;
  timeout: number;
  cooldown: number;
  maxAttempts: number;
  rule: string[];
  claudeBin: string;
  claudeArg: string[];
  once: boolean;
  dryRun: boolean;
}

const RULE_NAMES = DISPATCH_RULES.map((rule) => rule.name);

export function buildDispatchProgram(): Command {
  return new Command()
    .name("pr-dispatch")
    .description(
      "Poll global PR searches and dispatch /review, /fix-review, or /merge based on the labels pr-lifecycle maintains.",
    )
    .exitOverride()
    .option(
      "--owner <login>",
      "only PRs in repos owned by this user/org",
      "rmartz",
    )
    .option("--any-owner", "do not narrow the search by repo owner", false)
    .option(
      "--repos-root <dir>",
      "directory holding one local checkout per repo (<root>/<repo-name>)",
      path.join(homedir(), "Development"),
    )
    .option(
      "--log-dir <dir>",
      "per-job claude transcript logs",
      path.join(homedir(), ".local", "state", "pr-dispatch", "logs"),
    )
    .option(
      "--concurrency <n>",
      "max skills running at once",
      positiveNumber,
      3,
    )
    .option("--interval <seconds>", "poll interval", positiveNumber, 120)
    .option("--timeout <minutes>", "per-skill hard timeout", positiveNumber, 60)
    .option(
      "--cooldown <minutes>",
      "min gap before re-running the same skill on the same head SHA",
      positiveNumber,
      10,
    )
    .option(
      "--max-attempts <n>",
      "stop re-running the same skill on the same head SHA after n attempts",
      positiveNumber,
      3,
    )
    .option(
      "--rule <name>",
      `only dispatch these rules (repeatable): ${RULE_NAMES.join(", ")}`,
      collect,
      [],
    )
    .option("--claude-bin <path>", "claude executable", "claude")
    .option(
      "--claude-arg <arg>",
      "extra arg passed to claude before the prompt (repeatable), e.g. --claude-arg=--model --claude-arg=opus",
      collect,
      [],
    )
    .option(
      "--once",
      "run a single poll cycle, then wait for its jobs and exit",
      false,
    )
    .option(
      "--dry-run",
      "print what would be dispatched without running it",
      false,
    );
}

export function toDispatcherOptions(
  cli: DispatchCliOptions,
): DispatcherOptions {
  const unknown = cli.rule.filter((name) => !RULE_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new InvalidArgumentError(
      `unknown --rule ${unknown.join(", ")} (expected: ${RULE_NAMES.join(", ")})`,
    );
  }
  return {
    rules:
      cli.rule.length > 0
        ? DISPATCH_RULES.filter((rule) => cli.rule.includes(rule.name))
        : DISPATCH_RULES,
    owner: cli.anyOwner ? undefined : cli.owner,
    reposRoot: cli.reposRoot,
    logDir: cli.logDir,
    concurrency: cli.concurrency,
    intervalMs: cli.interval * 1000,
    timeoutMs: cli.timeout * 60_000,
    cooldownMs: cli.cooldown * 60_000,
    maxAttempts: cli.maxAttempts,
    claudeBin: cli.claudeBin,
    claudeArgs: cli.claudeArg,
    once: cli.once,
    dryRun: cli.dryRun,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const program = buildDispatchProgram();
  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  const options = toDispatcherOptions(program.opts<DispatchCliOptions>());

  // First SIGINT/SIGTERM: stop scheduling and let running skills finish.
  // Second: kill them.
  const stop = new AbortController();
  const kill = new AbortController();
  const log = (message: string) => {
    process.stdout.write(`${new Date().toISOString()} ${message}\n`);
  };
  const onSignal = () => {
    if (stop.signal.aborted) {
      log("second signal — killing running skills");
      kill.abort();
    } else {
      log("stopping — waiting for running skills (signal again to kill)");
      stop.abort();
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  log(
    `dispatching ${options.rules.map((rule) => rule.name).join(", ")} for ${options.owner ?? "any owner"}${options.dryRun ? " (dry run)" : ""}`,
  );
  await runDispatcher(options, {
    gh: defaultGhExec,
    runSkill,
    log,
    now: Date.now,
    stop: stop.signal,
    kill: kill.signal,
  });
  return 0;
}

// Run only when invoked as the script, not when imported (e.g. by tests).
async function run(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith(path.join("dispatcher", "cli.ts"))) {
  void run();
}
