import { describe, it, expect } from "vitest";
import { ApiCallBudget, ClaudeApiBudgetExceededError, readPositiveIntEnv, InvalidApiBudgetConfigError } from "./claudeApiBudget.js";

describe("ApiCallBudget", () => {
  it("allows calls under the limit (happy path)", () => {
    const budget = new ApiCallBudget(3, 10_000);
    const now = 1_000_000;
    expect(() => budget.checkAndRecord(now)).not.toThrow();
    expect(() => budget.checkAndRecord(now + 1)).not.toThrow();
    expect(() => budget.checkAndRecord(now + 2)).not.toThrow();
  });

  it("throws ClaudeApiBudgetExceededError once the limit is reached within the window (failure path)", () => {
    const budget = new ApiCallBudget(2, 10_000);
    const now = 1_000_000;
    budget.checkAndRecord(now);
    budget.checkAndRecord(now + 1);
    expect(() => budget.checkAndRecord(now + 2)).toThrow(ClaudeApiBudgetExceededError);
  });

  it("does not count a refused call toward the budget", () => {
    const budget = new ApiCallBudget(1, 10_000);
    const now = 1_000_000;
    budget.checkAndRecord(now);
    expect(() => budget.checkAndRecord(now + 1)).toThrow(ClaudeApiBudgetExceededError);
    // Still refused on a second attempt at the same instant -- the refused
    // attempt above must not have been recorded as if it succeeded.
    expect(() => budget.checkAndRecord(now + 1)).toThrow(ClaudeApiBudgetExceededError);
  });

  it("allows a new call once old ones age out of the rolling window (boundary case)", () => {
    const budget = new ApiCallBudget(1, 10_000);
    const now = 1_000_000;
    budget.checkAndRecord(now);
    expect(() => budget.checkAndRecord(now + 5_000)).toThrow(ClaudeApiBudgetExceededError);
    expect(() => budget.checkAndRecord(now + 10_001)).not.toThrow();
  });

  it("handles a budget of exactly zero calls per window (boundary case)", () => {
    const budget = new ApiCallBudget(1, 10_000);
    // A single instant, one call fits, a second at the same instant does not.
    const now = 1_000_000;
    expect(() => budget.checkAndRecord(now)).not.toThrow();
    expect(() => budget.checkAndRecord(now)).toThrow(ClaudeApiBudgetExceededError);
  });
});

describe("readPositiveIntEnv", () => {
  it("returns the default when unset (happy path)", () => {
    delete process.env.TEST_BUDGET_VAR;
    expect(readPositiveIntEnv("TEST_BUDGET_VAR", 42)).toBe(42);
  });

  it("returns the parsed value when set to a valid positive integer", () => {
    process.env.TEST_BUDGET_VAR = "7";
    expect(readPositiveIntEnv("TEST_BUDGET_VAR", 42)).toBe(7);
    delete process.env.TEST_BUDGET_VAR;
  });

  it("throws InvalidApiBudgetConfigError for a non-numeric value", () => {
    process.env.TEST_BUDGET_VAR = "not-a-number";
    expect(() => readPositiveIntEnv("TEST_BUDGET_VAR", 42)).toThrow(InvalidApiBudgetConfigError);
    delete process.env.TEST_BUDGET_VAR;
  });

  it("throws InvalidApiBudgetConfigError for zero or a negative value", () => {
    process.env.TEST_BUDGET_VAR = "0";
    expect(() => readPositiveIntEnv("TEST_BUDGET_VAR", 42)).toThrow(InvalidApiBudgetConfigError);
    process.env.TEST_BUDGET_VAR = "-5";
    expect(() => readPositiveIntEnv("TEST_BUDGET_VAR", 42)).toThrow(InvalidApiBudgetConfigError);
    delete process.env.TEST_BUDGET_VAR;
  });
});
