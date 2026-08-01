import { describe, expect, it } from "vitest";
import {
  computeCostUsd,
  PRICING,
  SONNET_MODEL,
  TaskBudget,
  TaskBudgetExceededError,
  UnknownModelPricingError,
} from "../src/budget.js";

describe("computeCostUsd", () => {
  it("prices input, output, cache-write, and cache-read tokens for a known model", () => {
    const cost = computeCostUsd(SONNET_MODEL, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    const pricing = PRICING[SONNET_MODEL];
    expect(pricing).toBeDefined();
    const expected =
      pricing?.inputPerM +
      pricing?.outputPerM +
      pricing?.inputPerM * 1.25 +
      pricing?.inputPerM * 0.1;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("throws UnknownModelPricingError for a model with no pricing entry", () => {
    expect(() =>
      computeCostUsd("not-a-real-model", {
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toThrow(UnknownModelPricingError);
  });
});

describe("TaskBudget", () => {
  it("allows calls while spend is below the ceiling", () => {
    const budget = new TaskBudget(1);
    expect(() => budget.assertCanCall()).not.toThrow();
    budget.record(0.5);
    expect(() => budget.assertCanCall()).not.toThrow();
    expect(budget.spent).toBe(0.5);
  });

  it("throws TaskBudgetExceededError once spend reaches the ceiling", () => {
    const budget = new TaskBudget(1);
    budget.record(1);
    expect(() => budget.assertCanCall()).toThrow(TaskBudgetExceededError);
  });

  it("throws once spend exceeds the ceiling, not just meets it exactly", () => {
    const budget = new TaskBudget(0.5);
    budget.record(0.3);
    expect(() => budget.assertCanCall()).not.toThrow();
    budget.record(0.3);
    expect(() => budget.assertCanCall()).toThrow(TaskBudgetExceededError);
  });
});
