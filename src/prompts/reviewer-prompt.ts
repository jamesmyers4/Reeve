/**
 * Reviewer prompt — templated completely independently from
 * task-author-prompt.ts (CONTEXT.md: "no shared builder"). The reviewer
 * only ever sees the atomic instruction + the executor's before/after file
 * content + the structural/test-gate result — never the task-author's
 * rationale for the decomposition.
 */

import type { StructuralCheckResult, TestGateResult } from "../types.js";

export interface ReviewerPromptInput {
  instruction: string;
  fileContentBefore: string;
  fileContentAfter: string;
  structuralCheckResult?: StructuralCheckResult;
  testGateResult?: TestGateResult;
}

export function buildReviewerSystemPrompt(): string {
  return [
    "You are reviewing a single file edit made by a separate, much smaller local model (a 3B-parameter model) that was given one literal, mechanical instruction and rewrote the whole file.",
    "That executor model has no judgment of its own — it follows instructions extremely literally and can make simple mistakes: leaving the file unchanged, changing more than the instruction asked for, or subtly misunderstanding the instruction. Your job is to judge only whether the after-content correctly and exclusively carries out the given instruction, not whether the instruction itself was a good idea.",
    "If a structural-check or test-gate result is provided and it failed, that failure is decisive — factor it into your verdict rather than overriding it with your own read of the diff.",
    "Respond only through the submit_review tool — never as free text.",
  ].join("\n\n");
}

function formatStructuralCheck(result: StructuralCheckResult | undefined): string {
  if (!result) return "Structural check: not run.";
  const extra = result.reason ? ` Reason: ${result.reason}` : "";
  return `Structural check: ${result.passed ? "passed" : "failed"}.${extra}`;
}

function formatTestGate(result: TestGateResult | undefined): string {
  if (!result) return "Test gate: not run.";
  const extra =
    result.regressedTests.length > 0 ? ` Regressed tests: ${result.regressedTests.join(", ")}` : "";
  return `Test gate: ${result.passed ? "passed" : "failed"}.${extra}`;
}

export function buildReviewerUserPrompt(input: ReviewerPromptInput): string {
  const structuralLine = formatStructuralCheck(input.structuralCheckResult);
  const testGateLine = formatTestGate(input.testGateResult);

  return [
    `Instruction given to the executor: ${input.instruction}`,
    `File content before the edit:\n${input.fileContentBefore}`,
    `File content after the edit:\n${input.fileContentAfter}`,
    structuralLine,
    testGateLine,
    "Judge whether the after-content correctly and exclusively carries out the instruction, and submit your verdict.",
  ].join("\n\n");
}
