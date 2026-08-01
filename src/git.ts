/**
 * Thin wrapper around shell `git`: branch creation, one commit per `passed`
 * step (message = that step's instruction), push over HTTPS using the
 * cross-repo PAT. Deliberately uses `execFileSync` with array args, never a
 * shell string — a commit message is `TaskStep.instruction`, model-authored
 * text that must never be interpreted by a shell.
 */

import { execFileSync } from "node:child_process";
import type { TaskRecord, TaskStep } from "./types.js";

const MAX_SLUG_LENGTH = 40;
const TASK_ID_PREFIX_LENGTH = 8;

export class GitCommandError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

/** Replaces every occurrence of `secret` with `***` — used so a PAT never lands in a thrown error's message, even if git's own credential redaction misses a code path. */
function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("***") : text;
}

function runGit(repoRoot: string, args: string[], secretToRedact?: string): string {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  } catch (err) {
    const cause = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const rawStderr =
      typeof cause.stderr === "string" ? cause.stderr : cause.stderr?.toString("utf8");
    const rawMessage = rawStderr?.trim() || cause.message || "git command failed";
    throw new GitCommandError(
      redact(`git ${args.join(" ")}`, secretToRedact),
      rawStderr !== undefined ? redact(rawStderr, secretToRedact) : undefined,
      redact(rawMessage, secretToRedact),
    );
  }
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || "task";
}

/** `qwen-task/<short-task-id>-<slug>` per CONTEXT.md's branch/PR convention. */
export function branchNameForTask(task: TaskRecord): string {
  const shortId = task.id.slice(0, TASK_ID_PREFIX_LENGTH);
  return `qwen-task/${shortId}-${slugify(task.description)}`;
}

/** Branches off whatever `repoRoot`'s current HEAD is — the caller is responsible for having already checked out the target repo's default branch. */
export function createTaskBranch(repoRoot: string, branchName: string): void {
  runGit(repoRoot, ["checkout", "-b", branchName]);
}

export function commitStep(repoRoot: string, step: TaskStep): void {
  runGit(repoRoot, ["add", "--", step.filePath]);
  runGit(repoRoot, ["commit", "-m", step.instruction]);
}

function authenticatedRemoteUrl(targetRepo: string, pat: string): string {
  return `https://x-access-token:${pat}@github.com/${targetRepo}.git`;
}

/** Pushes the current local branch (must match `branchName`) using a one-off authenticated URL — never persisted into the repo's own remote config. */
export function pushTaskBranch(
  repoRoot: string,
  targetRepo: string,
  branchName: string,
  pat: string,
): void {
  const remoteUrl = authenticatedRemoteUrl(targetRepo, pat);
  runGit(repoRoot, ["push", remoteUrl, branchName], pat);
}

export function currentCommitSha(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "HEAD"]).trim();
}

/** `git diff --stat` between the branch's starting point and its current HEAD — the "final diff summary" for a full-pass PR description. */
export function diffStat(repoRoot: string, baseRef: string): string {
  return runGit(repoRoot, ["diff", "--stat", `${baseRef}..HEAD`]).trim();
}
