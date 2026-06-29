import { describe, it, expect, vi } from "vitest";
import { Collections } from "@/db/collections";
import { StepStatus, StepType } from "@/db/schemas";
import { makeNoopRuntime } from "@/engine/runner/runner-tests/fixtures";
import { createRunner } from "@/engine/runner";
import { createClaudeSkillExecutor } from "../claudeSkill";
import { makeFakeChild, makeDb, makeRun, seedStep } from "./fixtures";

describe("claudeSkillExecutor heartbeats while the subprocess runs", () => {
  it("updates heartbeatAt on the configured interval", async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
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

describe("claudeSkillExecutor streams stdout/stderr into the step logs", () => {
  it("persists output lines to the step's logs", async () => {
    const db = makeDb();
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

  it("interleaves stdout and stderr lines by arrival order", async () => {
    const db = makeDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitOut("out-1\n");
    fake.emitErr("err-1\n");
    fake.emitOut("{}\n");
    fake.emitErr("err-2\n");
    fake.emitClose(0);
    await promise;
    const final = await db.get(Collections.stepInstances, "s1");
    expect(final?.logs).toEqual(["out-1", "err-1", "{}", "err-2"]);
  });

  it("keeps a chunk's own lines contiguous and split correctly", async () => {
    const db = makeDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitErr("err-a\nerr-b\n");
    fake.emitOut("out-a\n{}\n");
    fake.emitClose(0);
    await promise;
    const final = await db.get(Collections.stepInstances, "s1");
    expect(final?.logs).toEqual(["err-a", "err-b", "out-a", "{}"]);
  });

  it("carries a partial line forward across chunks of the same stream", async () => {
    const db = makeDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitOut("partial-");
    fake.emitOut("line\n{}\n");
    fake.emitClose(0);
    await promise;
    const final = await db.get(Collections.stepInstances, "s1");
    expect(final?.logs).toEqual(["partial-line", "{}"]);
  });
});

describe("the runner records metrics.claudeMs for a claude_skill step", () => {
  it("captures the subprocess running duration in the claudeMs bucket", async () => {
    const db = makeDb();
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
