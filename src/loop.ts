/**
 * The decompose -> execute -> gate -> review -> revise/pass/escalate loop.
 * `runStep()` is the per-step attempt loop (max 3); `runTask()` decomposes
 * a task and iterates `runStep()` over its steps in order, aborting the
 * remaining steps at the first escalation with no rollback of steps that
 * already passed (CONTEXT.md: "Partial progress").
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskBudget } from "./budget.js";
import type { ReeveDb } from "./db/reeve-db.js";
import { newId } from "./db/reeve-db.js";
import type { Executor } from "./providers/executor.js";
import type { Reviewer } from "./providers/reviewer.js";
import type { TaskAuthor } from "./providers/task-author.js";
import { runStructuralCheck } from "./structural-check.js";
import { captureTestBaseline, checkTestGate, type TestGateBaseline } from "./test-gate.js";
import type {
  Attempt,
  AttemptKind,
  StepStatus,
  StructuralCheckResult,
  TaskRecord,
  TaskStatus,
  TaskStep,
  TestGateResult,
  Verdict,
} from "./types.js";

/** Fixed, non-negotiable per CONTEXT.md — no cumulative task-wide budget, no free retries. */
export const MAX_ATTEMPTS_PER_STEP = 3;

export interface RunTaskContext {
  db: ReeveDb;
  taskAuthor: TaskAuthor;
  executor: Executor;
  reviewer: Reviewer;
  budget: TaskBudget;
  /** Absolute path to the checked-out working tree the task's steps edit files within. */
  repoRoot: string;
  /** Optional baseline-diff test gate command, run once at task start and again after each step's edit. */
  testCommand?: string;
}

export interface RunTaskInput {
  description: string;
  targetRepo: string;
}

function recordAttempt(
  db: ReeveDb,
  stepId: string,
  attemptNumber: number,
  kind: AttemptKind,
  fileContentBefore: string,
  fileContentAfter: string,
  verdict: Verdict,
  reasoning: string,
  costUsd: number,
  structuralCheckResult?: StructuralCheckResult,
  testGateResult?: TestGateResult,
): void {
  const attempt: Attempt = {
    id: newId(),
    stepId,
    attemptNumber,
    kind,
    fileContentBefore,
    fileContentAfter,
    verdict,
    reasoning,
    costUsd,
    createdAt: Date.now(),
    ...(structuralCheckResult !== undefined && { structuralCheckResult }),
    ...(testGateResult !== undefined && { testGateResult }),
  };
  db.insertAttempt(attempt);
}

/** The last permitted attempt escalates on any gate failure, regardless of what that gate's own verdict would otherwise have been. */
function verdictForFailedGate(attemptNumber: number): Verdict {
  return attemptNumber === MAX_ATTEMPTS_PER_STEP ? "escalate" : "revise";
}

async function runStep(
  step: TaskStep,
  ctx: RunTaskContext,
  baseline: TestGateBaseline | undefined,
): Promise<StepStatus> {
  const absolutePath = join(ctx.repoRoot, step.filePath);
  const fileContentBefore = readFileSync(absolutePath, "utf8");
  let currentInstruction = step.instruction;
  let finalStatus: StepStatus = "escalated";

  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS_PER_STEP; attemptNumber++) {
    const { newContent } = await ctx.executor.rewrite(currentInstruction, fileContentBefore);

    const structuralCheckResult = runStructuralCheck(absolutePath, newContent);
    if (!structuralCheckResult.passed) {
      const verdict = verdictForFailedGate(attemptNumber);
      recordAttempt(
        ctx.db,
        step.id,
        attemptNumber,
        "structural-check",
        fileContentBefore,
        newContent,
        verdict,
        structuralCheckResult.reason ?? "Structural check failed.",
        0,
        structuralCheckResult,
      );
      if (verdict === "escalate") break;
      continue;
    }

    // Written to disk so the test-gate command (and, eventually, git) sees
    // a real working tree — reverted below if this step never lands a pass.
    writeFileSync(absolutePath, newContent, "utf8");

    let testGateResult: TestGateResult | undefined;
    if (baseline) {
      testGateResult = checkTestGate(baseline);
      if (!testGateResult.passed) {
        const verdict = verdictForFailedGate(attemptNumber);
        recordAttempt(
          ctx.db,
          step.id,
          attemptNumber,
          "test-gate",
          fileContentBefore,
          newContent,
          verdict,
          `Test gate regressed: ${testGateResult.regressedTests.join(", ")}`,
          0,
          structuralCheckResult,
          testGateResult,
        );
        if (verdict === "escalate") break;
        continue;
      }
    }

    ctx.budget.assertCanCall();
    const { result: review, usage } = await ctx.reviewer.review({
      instruction: currentInstruction,
      fileContentBefore,
      fileContentAfter: newContent,
      ...(structuralCheckResult !== undefined && { structuralCheckResult }),
      ...(testGateResult !== undefined && { testGateResult }),
    });
    ctx.budget.record(usage.costUsd);
    recordAttempt(
      ctx.db,
      step.id,
      attemptNumber,
      "review",
      fileContentBefore,
      newContent,
      review.verdict,
      review.reasoning,
      usage.costUsd,
      structuralCheckResult,
      testGateResult,
    );

    if (review.verdict === "pass") {
      finalStatus = "passed";
      break;
    }
    if (review.verdict === "escalate" || attemptNumber === MAX_ATTEMPTS_PER_STEP) {
      break; // finalStatus stays "escalated"
    }
    currentInstruction = review.revisedInstruction ?? currentInstruction;
  }

  if (finalStatus !== "passed") {
    // No rollback of steps that already passed — but this step's own edit
    // never landed, so the working tree shouldn't carry it forward.
    writeFileSync(absolutePath, fileContentBefore, "utf8");
  }
  return finalStatus;
}

export async function runTask(input: RunTaskInput, ctx: RunTaskContext): Promise<TaskRecord> {
  const task: TaskRecord = {
    id: newId(),
    description: input.description,
    targetRepo: input.targetRepo,
    status: "pending",
    createdAt: Date.now(),
  };
  ctx.db.insertTask(task);
  ctx.db.updateTaskStatus(task.id, "running");

  ctx.budget.assertCanCall();
  const decomposeOutcome = await ctx.taskAuthor.decompose(input.description, input.targetRepo);
  ctx.budget.record(decomposeOutcome.usage.costUsd);

  if (decomposeOutcome.result.escalate) {
    const status: TaskStatus = "escalated-preflight";
    ctx.db.updateTaskStatus(task.id, status);
    return { ...task, status };
  }

  const baseline = ctx.testCommand ? captureTestBaseline(ctx.testCommand, ctx.repoRoot) : undefined;

  let taskEscalated = false;
  for (const draft of decomposeOutcome.result.steps) {
    const step: TaskStep = {
      id: newId(),
      taskId: task.id,
      index: ctx.db.listStepsForTask(task.id).length,
      instruction: draft.instruction,
      filePath: draft.filePath,
      status: "pending",
    };
    ctx.db.insertStep(step);

    const stepStatus = await runStep(step, ctx, baseline);
    ctx.db.updateStepStatus(step.id, stepStatus);

    if (stepStatus === "escalated") {
      taskEscalated = true;
      break; // remaining steps are never attempted, never inserted
    }
  }

  const status: TaskStatus = taskEscalated ? "escalated" : "passed";
  ctx.db.updateTaskStatus(task.id, status);
  return { ...task, status };
}
