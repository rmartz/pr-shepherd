import { describe, it, expect } from "vitest";
import { Collections } from "@/db/collections";
import { makeNoopRuntime } from "@/engine/runner/runner-tests/fixtures";
import { createClaudeSkillExecutor } from "../claudeSkill";
import { makeFakeChild, makeDb, seedStep } from "./fixtures";

describe("claudeSkillExecutor returns parsed output on a clean exit", () => {
  it("parses JSON stdout into the step output", async () => {
    const db = makeDb();
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
    const db = makeDb();
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
    const db = makeDb();
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
    const db = makeDb();
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

describe("claudeSkillExecutor fails on a non-zero exit", () => {
  it("rejects with the exit code and stderr", async () => {
    const db = makeDb();
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
    const db = makeDb();
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
