/**
 * Core domain types for a task run through the Reeve loop:
 * one TaskRecord decomposes into ordered TaskSteps, each of which
 * accumulates up to 3 Attempts (structural check / test gate / review)
 * before landing on pass or escalate.
 */

export type TaskStatus = "pending" | "running" | "passed" | "escalated" | "escalated-preflight";

export interface TaskRecord {
  id: string;
  description: string;
  targetRepo: string;
  status: TaskStatus;
  branchName?: string;
  prUrl?: string;
  createdAt: number;
}

export type StepStatus = "pending" | "passed" | "escalated";

export interface TaskStep {
  id: string;
  taskId: string;
  index: number;
  instruction: string;
  filePath: string;
  status: StepStatus;
}

export type AttemptKind = "structural-check" | "test-gate" | "review";

export type Verdict = "pass" | "revise" | "escalate";

/** Outcome of the structural-check guard (non-empty/non-truncated/best-effort parse). */
export interface StructuralCheckResult {
  passed: boolean;
  reason?: string;
}

/** Outcome of diffing baseline test failures against post-edit test failures. */
export interface TestGateResult {
  passed: boolean;
  regressedTests: string[];
}

export interface Attempt {
  id: string;
  stepId: string;
  attemptNumber: number;
  kind: AttemptKind;
  fileContentBefore: string;
  fileContentAfter: string;
  structuralCheckResult?: StructuralCheckResult;
  testGateResult?: TestGateResult;
  verdict: Verdict;
  reasoning: string;
  costUsd: number;
  createdAt: number;
}
