/**
 * Turns a completed (or escalated) `runTask()` result into a real branch,
 * PR, and email. Not named in CONTEXT.md's architecture diagram (only
 * git.ts/pr.ts/notify.ts are) — added because "turn a task result into a
 * branch/PR/email" is one cohesive operation that needs task/step/attempt
 * data from all three, and building that composition once here means
 * Session 5's cli.ts calls a single tested function instead of
 * re-deriving this logic inline.
 *
 * Branch/PR mechanism reuse (CONTEXT.md): full pass -> PR ready for
 * review; step-escalation -> same PR mechanism as --draft; pre-flight
 * escalation -> no git/PR call at all, email only.
 */

import type { ReeveDb } from "./db/reeve-db.js";
import {
  branchNameForTask,
  commitStep,
  createTaskBranch,
  currentCommitSha,
  diffStat,
  pushTaskBranch,
} from "./git.js";
import type { RunTaskResult } from "./loop.js";
import { buildEscalationEmail, buildFinalPassEmail, sendEmail } from "./notify.js";
import { createPr } from "./pr.js";
import type { Attempt, TaskStep } from "./types.js";

export interface DeliverContext {
  db: ReeveDb;
  /** Absolute path to the checked-out working tree the task's steps edited files within. */
  repoRoot: string;
  /** Cross-repo PAT used to push the branch over HTTPS. */
  pat: string;
  /** Single-operator notification recipient. */
  notifyEmail: string;
}

export interface DeliverResult {
  branchName?: string;
  prUrl?: string;
}

function lastAttemptSummary(db: ReeveDb, step: TaskStep): string {
  const attempts = db.listAttemptsForStep(step.id);
  const last: Attempt | undefined = attempts.at(-1);
  if (!last) {
    return `Step "${step.filePath}" escalated with no recorded attempts.`;
  }
  const parts = [
    `Step "${step.filePath}" escalated after ${attempts.length} attempt(s).`,
    `Last attempt reasoning: ${last.reasoning}`,
  ];
  if (last.structuralCheckResult && !last.structuralCheckResult.passed) {
    parts.push(`Structural check failed: ${last.structuralCheckResult.reason ?? "(no detail)"}`);
  }
  if (last.testGateResult && !last.testGateResult.passed) {
    parts.push(`Test gate regressed: ${last.testGateResult.regressedTests.join(", ")}`);
  }
  return parts.join("\n\n");
}

function buildFullPassBody(
  task: RunTaskResult,
  passedSteps: TaskStep[],
  diffSummary: string,
): string {
  const stepLines = passedSteps
    .map((s, i) => `${i + 1}. **${s.filePath}** — ${s.instruction}`)
    .join("\n");
  return [
    `Task: ${task.description}`,
    `All ${passedSteps.length} step(s) passed review.`,
    stepLines,
    `Diff summary:\n${diffSummary}`,
  ].join("\n\n");
}

function buildStepEscalationBody(
  db: ReeveDb,
  task: RunTaskResult,
  passedSteps: TaskStep[],
  escalatedStep: TaskStep | undefined,
): string {
  const safeLines = passedSteps.length
    ? passedSteps.map((s, i) => `${i + 1}. **${s.filePath}** (safe) — ${s.instruction}`).join("\n")
    : "(none — the first step attempted escalated)";
  const escalationSummary = escalatedStep
    ? lastAttemptSummary(db, escalatedStep)
    : "A step escalated, but no escalated step record was found.";
  return [
    `Task: ${task.description}`,
    "Steps that passed review and are safe to merge:",
    safeLines,
    "Escalated step:",
    escalationSummary,
  ].join("\n\n");
}

const MAX_PR_TITLE_LENGTH = 120;

function prTitleForTask(task: RunTaskResult): string {
  const title = `Reeve: ${task.description}`;
  return title.length > MAX_PR_TITLE_LENGTH ? `${title.slice(0, MAX_PR_TITLE_LENGTH - 1)}…` : title;
}

export async function deliverTaskOutcome(
  task: RunTaskResult,
  ctx: DeliverContext,
): Promise<DeliverResult> {
  if (task.status === "escalated-preflight") {
    await sendEmail(
      buildEscalationEmail({
        task,
        to: ctx.notifyEmail,
        reason: task.preflightReason ?? "Task-author escalated before any step was attempted.",
      }),
    );
    return {};
  }

  const steps = ctx.db.listStepsForTask(task.id);
  const passedSteps = steps.filter((s) => s.status === "passed");
  const escalatedStep = steps.find((s) => s.status === "escalated");
  const isFullPass = task.status === "passed";

  const baseSha = currentCommitSha(ctx.repoRoot);
  const branchName = branchNameForTask(task);
  createTaskBranch(ctx.repoRoot, branchName);
  for (const step of passedSteps) {
    commitStep(ctx.repoRoot, step);
  }
  pushTaskBranch(ctx.repoRoot, task.targetRepo, branchName, ctx.pat);

  const body = isFullPass
    ? buildFullPassBody(task, passedSteps, diffStat(ctx.repoRoot, baseSha))
    : buildStepEscalationBody(ctx.db, task, passedSteps, escalatedStep);

  const { url } = createPr({
    repoRoot: ctx.repoRoot,
    targetRepo: task.targetRepo,
    branchName,
    title: prTitleForTask(task),
    body,
    draft: !isFullPass,
  });

  ctx.db.updateTaskBranch(task.id, branchName);
  ctx.db.updateTaskPrUrl(task.id, url);

  if (isFullPass) {
    await sendEmail(buildFinalPassEmail({ task, to: ctx.notifyEmail, prUrl: url }));
  } else {
    const reason = escalatedStep
      ? lastAttemptSummary(ctx.db, escalatedStep)
      : "A step escalated, but no escalated step record was found.";
    await sendEmail(buildEscalationEmail({ task, to: ctx.notifyEmail, prUrl: url, reason }));
  }

  return { branchName, prUrl: url };
}
