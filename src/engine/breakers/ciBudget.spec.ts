import { describe, it, expect } from "vitest";
import { createCiBudgetBreaker, isCiBudgetExhausted } from "./ciBudget";

describe("isCiBudgetExhausted detects a startup_failure majority", () => {
  it("is exhausted when most recent main runs are startup_failure", () => {
    expect(
      isCiBudgetExhausted(["startup_failure", "startup_failure", "success"]),
    ).toBe(true);
  });

  it("is not exhausted on a minority of startup_failures", () => {
    expect(isCiBudgetExhausted(["startup_failure", "success", "success"])).toBe(
      false,
    );
  });

  it("is not exhausted with no runs", () => {
    expect(isCiBudgetExhausted([])).toBe(false);
  });
});

describe("the CI-budget breaker trips, latches, and gates dispatch", () => {
  it("stays closed while runs are healthy", () => {
    const breaker = createCiBudgetBreaker();
    breaker.observe(["success", "success", "startup_failure"]);
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.allowsDispatch(false)).toBe(true);
  });

  it("trips open on exhaustion and latches even after runs recover", () => {
    const breaker = createCiBudgetBreaker();
    breaker.observe(["startup_failure", "startup_failure"]);
    expect(breaker.isOpen()).toBe(true);
    // A later healthy observation does NOT close it — latched for the process.
    breaker.observe(["success", "success"]);
    expect(breaker.isOpen()).toBe(true);
  });

  it("when open, only an already-CI-passed PR may dispatch", () => {
    const breaker = createCiBudgetBreaker();
    breaker.observe(["startup_failure", "startup_failure"]);
    expect(breaker.allowsDispatch(true)).toBe(true);
    expect(breaker.allowsDispatch(false)).toBe(false);
  });
});
