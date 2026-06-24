import { spawn } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import type { Db } from "@/db/types";
import { createRunner } from "@/engine/runner";
import { makeNoopRuntime } from "@/engine/runner/runner-tests/fixtures";
import {
  createClaudeSkillExecutor,
  scrubGithubEnv,
  type SpawnedProcess,
} from "./claudeSkill";

// ---------------------------------------------------------------------------
// Tests for the claude_skill executor. A fake spawned process is injected so
// the subprocess lifecycle (stdout/stderr, exit code, heartbeat, cancel) is
// driven deterministically; the env-scrub test uses a real `printenv` child.
// ---------------------------------------------------------------------------

interface FakeChild {
  child: SpawnedProcess;
  kill: ReturnType<typeof vi.fn>;
  emitOut: (s: string) => void;
  emitErr: (s: string) => void;
  emitClose: (code: number | null) => void;
  emitError: (err: Error) => void;
}

function makeFakeChild(): FakeChild {
  let outCb: ((chunk: string) => void) | undefined;
  let errCb: ((chunk: string) => void) | undefined;
  let closeCb: ((code: number | null) => void | Promise<void>) | undefined;
  let errorCb: ((err: Error) => void) | undefined;
  const kill = vi.fn((): boolean => true);
  const child = {
    stdout: {
      on: (event: "data", listener: (chunk: string) => void) => {
        outCb = listener;
      },
    },
    stderr: {
      on: (event: "data", listener: (chunk: string) => void) => {
        errCb = listener;
      },
    },
    on: (event: "close" | "error", listener: (arg: never) => void) => {
      if (event === "close")
        closeCb = listener as (code: number | null) => void | Promise<void>;
      else errorCb = listener as (err: Error) => void;
    },
    kill,
  } as unknown as SpawnedProcess;
  return {
    child,
    kill,
    emitOut: (s) => outCb?.(s),
    emitErr: (s) => errCb?.(s),
    emitClose: (code) => {
      void closeCb?.(code);
    },
    emitError: (err) => errorCb?.(err),
  };
}

function makeStep(overrides: Partial<StepInstance> = {}): StepInstance {
  return {
    id: "s1",
    runId: "run-1",
    stepDefinitionId: "review",
    stepType: StepType.ClaudeSkill,
    status: StepStatus.Running,
    input: { skill: "/review", args: ["7"] },
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1,
    startedAt: 2,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
    ...overrides,
  };
}

function makeRun(): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "owner/repo",
    prNumber: 7,
    prTitle: "test",
    status: RunStatus.Running,
    childRunIds: [],
    context: {},
    createdAt: 1,
    updatedAt: 1,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
  };
}

async function seedStep(
  db: Db,
  overrides: Partial<StepInstance> = {},
): Promise<StepInstance> {
  const step = makeStep(overrides);
  await db.create(Collections.stepInstances, step);
  return step;
}

describe("claudeSkillExecutor returns parsed output on a clean exit", () => {
  it("parses JSON stdout into the step output", async () => {
    const db = createInMemoryDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitOut(JSON.stringify({ verdict: "approved", body: "lgtm" }));
    fake.emitClose(0);
    const result = await promise;
    expect(result.output).toEqual({ verdict: "approved", body: "lgtm" });
  });
});

describe("claudeSkillExecutor tolerates CLI preamble before the JSON", () => {
  it("parses the final JSON-object line after progress noise", async () => {
    const db = createInMemoryDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitOut("Loading skill...\nAnalyzing...\n");
    fake.emitOut(JSON.stringify({ verdict: "approved" }) + "\n");
    fake.emitClose(0);
    const result = await promise;
    expect(result.output).toEqual({ verdict: "approved" });
  });
});

describe("claudeSkillExecutor fails loudly on unparseable stdout", () => {
  it("rejects when a clean exit emits no JSON object", async () => {
    const db = createInMemoryDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitOut("progress text with no JSON at all");
    fake.emitClose(0);
    await expect(promise).rejects.toThrow("no parseable JSON object");
  });

  it("still persists streamed logs before rejecting", async () => {
    const db = createInMemoryDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitOut("noise line\n");
    fake.emitClose(0);
    await expect(promise).rejects.toThrow();
    const final = await db.get(Collections.stepInstances, "s1");
    expect(final?.logs).toEqual(["noise line"]);
  });
});

describe("claudeSkillExecutor scrubs GitHub credentials from the subprocess env", () => {
  it("removes GITHUB_TOKEN / GH_TOKEN / *MCP*GITHUB* (verified via a real printenv child)", () => {
    const env = scrubGithubEnv({
      GITHUB_TOKEN: "secret-1",
      GH_TOKEN: "secret-2",
      GITHUB_MCP_PAT: "secret-3",
      KEEP_ME: "ok",
      PATH: process.env["PATH"],
    });
    return new Promise<void>((resolve, reject) => {
      // tsc needs the repo-augmented NodeJS.ProcessEnv here (without it the
      // spawn overload resolves to `never`); the scrubbed value is a plain
      // string map.
      const child = spawn("printenv", [], {
        env: env as unknown as NodeJS.ProcessEnv,
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.on("error", reject);
      child.on("close", () => {
        try {
          expect(out).toContain("KEEP_ME=ok");
          expect(out).not.toContain("GITHUB_TOKEN=");
          expect(out).not.toContain("GH_TOKEN=");
          expect(out).not.toContain("GITHUB_MCP_PAT=");
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  });

  it("scrubGithubEnv drops the credential keys and keeps the rest", () => {
    const scrubbed = scrubGithubEnv({
      GITHUB_TOKEN: "x",
      GH_TOKEN: "y",
      MCP_GITHUB_SERVER_TOKEN: "z",
      HOME: "/home/me",
    });
    expect(scrubbed).toEqual({ HOME: "/home/me" });
  });
});

describe("claudeSkillExecutor heartbeats while the subprocess runs", () => {
  it("updates heartbeatAt on the configured interval", async () => {
    vi.useFakeTimers();
    try {
      const db = createInMemoryDb();
      await seedStep(db);
      const updateSpy = vi.spyOn(db, "update");
      const fake = makeFakeChild();
      let clock = 0;
      const exec = createClaudeSkillExecutor(db, {
        spawn: () => fake.child,
        now: () => clock,
        heartbeatIntervalMs: 10,
      });
      const step = await db.get(Collections.stepInstances, "s1");
      const promise = exec(step!, makeNoopRuntime());
      clock = 10;
      await vi.advanceTimersByTimeAsync(10);
      clock = 20;
      await vi.advanceTimersByTimeAsync(10);
      const heartbeats = updateSpy.mock.calls.filter(
        (call) => "heartbeatAt" in (call[2] as Record<string, unknown>),
      );
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      fake.emitClose(0);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("claudeSkillExecutor fails on a non-zero exit", () => {
  it("rejects with the exit code and stderr", async () => {
    const db = createInMemoryDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitErr("boom");
    fake.emitClose(2);
    await expect(promise).rejects.toThrow(
      "claude subprocess exited with code 2: boom",
    );
  });

  it("truncates stderr to its last 200 characters in the error message", async () => {
    const db = createInMemoryDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitErr("x".repeat(300));
    fake.emitClose(1);
    await expect(promise).rejects.toThrow(
      "claude subprocess exited with code 1: " + "x".repeat(200),
    );
  });
});

describe("claudeSkillExecutor cancels on the abort signal", () => {
  it("SIGTERMs then SIGKILLs after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const db = createInMemoryDb();
      await seedStep(db);
      const controller = new AbortController();
      const fake = makeFakeChild();
      const exec = createClaudeSkillExecutor(db, {
        spawn: () => fake.child,
        graceMs: 100,
        signal: controller.signal,
      });
      const step = await db.get(Collections.stepInstances, "s1");
      const promise = exec(step!, makeNoopRuntime());
      controller.abort();
      expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
      fake.emitClose(null);
      await expect(promise).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("claudeSkillExecutor streams stdout/stderr into the step logs", () => {
  it("persists output lines to the step's logs", async () => {
    const db = createInMemoryDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitOut('progress line\n{"verdict":"approved"}\n');
    fake.emitErr("err1\n");
    fake.emitClose(0);
    await promise;
    const final = await db.get(Collections.stepInstances, "s1");
    expect(final?.logs).toEqual([
      "progress line",
      '{"verdict":"approved"}',
      "err1",
    ]);
  });
});

describe("the runner records metrics.claudeMs for a claude_skill step", () => {
  it("captures the subprocess running duration in the claudeMs bucket", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    await seedStep(db, { status: StepStatus.Queued });
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const runner = createRunner(db, { [StepType.ClaudeSkill]: exec });
    const step = await db.get(Collections.stepInstances, "s1");
    const dispatchPromise = runner.dispatch(step!);
    // Let the step run for a measurable interval before the subprocess exits.
    await new Promise((r) => setTimeout(r, 12));
    fake.emitOut("{}");
    fake.emitClose(0);
    await dispatchPromise;
    const final = await db.get(Collections.stepInstances, "s1");
    expect(final?.status).toBe(StepStatus.Completed);
    expect(final?.metrics.activeMs).toBe(0);
    expect(final?.metrics.claudeMs).toBeGreaterThan(0);
  });
});
