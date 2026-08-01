/**
 * Cost accounting and the per-task hard dollar ceiling. Unlike Drover's
 * SessionBudget (a soft per-persona-session cap the orchestrator checks
 * after the fact), Reeve's ceiling must never be crossed mid-write —
 * assertCanCall() is checked before every Sonnet call, so a call that would
 * exceed it never happens at all.
 */

export const SONNET_MODEL = "claude-sonnet-5";

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerM: number;
  /** USD per 1,000,000 output tokens. */
  outputPerM: number;
}

/** Cached 2026-06-24 (see the claude-api skill's model table); standard list pricing, not the 2026-08-31 intro rate. */
export const PRICING: Record<string, ModelPricing> = {
  [SONNET_MODEL]: { inputPerM: 3.0, outputPerM: 15.0 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export class UnknownModelPricingError extends Error {
  constructor(model: string) {
    super(`No pricing entry for model "${model}" — add one to PRICING in src/budget.ts`);
    this.name = "UnknownModelPricingError";
  }
}

export function computeCostUsd(model: string, usage: TokenUsage): number {
  const pricing = PRICING[model];
  if (!pricing) throw new UnknownModelPricingError(model);
  const cacheWritePerM = pricing.inputPerM * 1.25;
  const cacheReadPerM = pricing.inputPerM * 0.1;
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerM +
    (usage.outputTokens / 1_000_000) * pricing.outputPerM +
    (usage.cacheWriteTokens / 1_000_000) * cacheWritePerM +
    (usage.cacheReadTokens / 1_000_000) * cacheReadPerM
  );
}

export class TaskBudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly ceilingUsd: number,
  ) {
    super(
      `Task budget ceiling exceeded: $${spentUsd.toFixed(4)} spent of a $${ceilingUsd.toFixed(2)} ceiling`,
    );
    this.name = "TaskBudgetExceededError";
  }
}

/**
 * Hard per-task dollar ceiling. `assertCanCall()` is checked before every
 * Sonnet call (the task-author call, every review call) — once spend has
 * reached the ceiling, it throws instead of letting one more call through.
 */
export class TaskBudget {
  private spentUsd = 0;

  constructor(readonly ceilingUsd: number) {}

  get spent(): number {
    return this.spentUsd;
  }

  assertCanCall(): void {
    if (this.spentUsd >= this.ceilingUsd) {
      throw new TaskBudgetExceededError(this.spentUsd, this.ceilingUsd);
    }
  }

  record(costUsd: number): void {
    this.spentUsd += costUsd;
  }
}
