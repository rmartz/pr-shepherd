import { describe, it, expect, vi } from "vitest";
import { Collections } from "@/db/collections";
import { makeNoopRuntime } from "@/engine/runner/runner-tests/fixtures";
import { createClaudeSkillExecutor } from "../claudeSkill";
import { makeFakeChild, makeDb, seedStep } from "./fixtures";

describe("claudeSkillExecutor cancels on the abort signal", () => {
  it("SIGTERMs then SIGKILLs after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
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
      fake.emitClose(null, "SIGTERM");
      await expect(promise).rejects.toThrow(
        "claude subprocess terminated by signal SIGTERM",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the signal in the error when killed with no exit code", async () => {
    const db = makeDb();
    await seedStep(db);
    const fake = makeFakeChild();
    const exec = createClaudeSkillExecutor(db, { spawn: () => fake.child });
    const step = await db.get(Collections.stepInstances, "s1");
    const promise = exec(step!, makeNoopRuntime());
    fake.emitClose(null, "SIGKILL");
    await expect(promise).rejects.toThrow(
      "claude subprocess terminated by signal SIGKILL",
    );
  });
});
