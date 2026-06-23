import { describe, it, expect } from "vitest";
import {
  runWaitExternal,
  WaitExternalInputSchema,
  WaitExternalKind,
} from "../waitExternal";
import { makeFakeProcess, makeSpawnFn, makeCapturingSpawnFn } from "./fixtures";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

describe("WaitExternalInputSchema rejects invalid input", () => {
  it("rejects an unknown kind", () => {
    expect(() =>
      WaitExternalInputSchema.parse({ kind: "unknown", pr: 1 }),
    ).toThrow();
  });

  it("rejects a missing pr field", () => {
    expect(() => WaitExternalInputSchema.parse({ kind: "ci" })).toThrow();
  });

  it("accepts ci kind with pr and optional args", () => {
    const parsed = WaitExternalInputSchema.parse({
      kind: "ci",
      pr: 42,
      args: ["--timeout=120"],
    });
    expect(parsed.kind).toBe("ci");
    expect(parsed.pr).toBe(42);
    expect(parsed.args).toEqual(["--timeout=120"]);
  });
});

describe("WaitExternalInputSchema accepts the fix_pr kind", () => {
  it("parses fix_pr as a valid kind", () => {
    const parsed = WaitExternalInputSchema.parse({ kind: "fix_pr", pr: 9 });
    expect(parsed.kind).toBe(WaitExternalKind.FixPr);
  });
});

// ---------------------------------------------------------------------------
// runWaitExternal — ci happy path
// ---------------------------------------------------------------------------

describe("runWaitExternal ci-wait happy path: subprocess exits 0", () => {
  it("resolves with passed: true when the subprocess exits 0", async () => {
    const proc = makeFakeProcess();
    const resultPromise = runWaitExternal(
      { kind: WaitExternalKind.Ci, pr: 42 },
      { spawn: makeSpawnFn(proc) },
    );
    proc.emitClose(0);
    const result = await resultPromise;
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runWaitExternal — copilot_review happy path
// ---------------------------------------------------------------------------

describe("runWaitExternal copilot-review-wait happy path: subprocess exits 0", () => {
  it("resolves with passed: true when the subprocess exits 0", async () => {
    const proc = makeFakeProcess();
    const resultPromise = runWaitExternal(
      { kind: WaitExternalKind.CopilotReview, pr: 7 },
      { spawn: makeSpawnFn(proc) },
    );
    proc.emitClose(0);
    const result = await resultPromise;
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runWaitExternal — fix_pr kind (waits on a spawned child / fix PR)
// ---------------------------------------------------------------------------

describe("runWaitExternal fix-pr-wait happy path: subprocess exits 0", () => {
  it("resolves with passed: true when the fix PR's wait subprocess exits 0", async () => {
    const proc = makeFakeProcess();
    const resultPromise = runWaitExternal(
      { kind: WaitExternalKind.FixPr, pr: 314 },
      { spawn: makeSpawnFn(proc) },
    );
    proc.emitClose(0);
    const result = await resultPromise;
    expect(result.passed).toBe(true);
  });

  it("waits via wait-for-ci.py keyed off the fix PR number", async () => {
    const proc = makeFakeProcess();
    const { spawn, calls } = makeCapturingSpawnFn(proc);
    const resultPromise = runWaitExternal(
      { kind: WaitExternalKind.FixPr, pr: 314 },
      { spawn },
    );
    proc.emitClose(0);
    await resultPromise;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toContain("wait-for-ci.py");
    expect(calls[0]?.args[0]).toBe("314");
  });
});

// ---------------------------------------------------------------------------
// runWaitExternal — timeout exit (exit code 1)
// ---------------------------------------------------------------------------

describe("runWaitExternal timeout exit captured as failed with reason: timeout", () => {
  it("resolves with passed: false and reason: timeout when subprocess exits 1", async () => {
    const proc = makeFakeProcess();
    const resultPromise = runWaitExternal(
      { kind: WaitExternalKind.Ci, pr: 42 },
      { spawn: makeSpawnFn(proc) },
    );
    proc.emitClose(1);
    const result = await resultPromise;
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reason).toBe("timeout");
    }
  });

  it("resolves with passed: false and reason: error for non-zero non-timeout exit code", async () => {
    const proc = makeFakeProcess();
    const resultPromise = runWaitExternal(
      { kind: WaitExternalKind.Ci, pr: 42 },
      { spawn: makeSpawnFn(proc) },
    );
    proc.emitClose(2);
    const result = await resultPromise;
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reason).toBe("error");
    }
  });
});

describe("runWaitExternal spawn error path", () => {
  it("resolves with passed: false and reason: error and removes abort listener", async () => {
    const proc = makeFakeProcess();
    const controller = new AbortController();
    const resultPromise = runWaitExternal(
      { kind: WaitExternalKind.Ci, pr: 42 },
      { spawn: makeSpawnFn(proc), signal: controller.signal },
    );
    proc.emitError(new Error("spawn failed"));
    const result = await resultPromise;
    expect(result).toEqual({ passed: false, reason: "error" });

    controller.abort();
    expect(proc.signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runWaitExternal — cancellation: SIGTERM then SIGKILL after grace period
// ---------------------------------------------------------------------------

describe("runWaitExternal cancellation sends SIGTERM then SIGKILL after grace period", () => {
  it("sends SIGTERM immediately on abort and SIGKILL when the grace timer fires", async () => {
    const proc = makeFakeProcess();
    const controller = new AbortController();

    let graceFn: (() => void) | undefined;
    const fakeSetTimeout = (fn: () => void) => {
      graceFn = fn;
      return {} as ReturnType<typeof setTimeout>;
    };

    const resultPromise = runWaitExternal(
      { kind: WaitExternalKind.Ci, pr: 42 },
      {
        spawn: makeSpawnFn(proc),
        signal: controller.signal,
        setTimeout: fakeSetTimeout,
      },
    );

    // Trigger cancel — SIGTERM should be sent synchronously.
    controller.abort();
    expect(proc.signals).toContain("SIGTERM");

    // Grace timer fires → SIGKILL.
    expect(graceFn).toBeDefined();
    graceFn!();
    expect(proc.signals).toContain("SIGKILL");

    // Subprocess eventually exits (killed).
    proc.emitClose(null);
    const result = await resultPromise;
    expect(result.passed).toBe(false);
  });

  it("honors a pre-aborted signal before registering listeners", async () => {
    const proc = makeFakeProcess();
    const controller = new AbortController();
    controller.abort();

    const resultPromise = runWaitExternal(
      { kind: WaitExternalKind.Ci, pr: 42 },
      { spawn: makeSpawnFn(proc), signal: controller.signal },
    );

    expect(proc.signals).toContain("SIGTERM");
    proc.emitClose(null);
    const result = await resultPromise;
    expect(result.passed).toBe(false);
  });
});
