/**
 * `gh pr create` wrapper — ready-for-review vs. draft, per-outcome
 * description (the description text itself is composed by deliver.ts,
 * which has the task/step/attempt data; this module only knows how to turn
 * a title/body/draft flag into a real PR).
 */

import { execFileSync } from "node:child_process";

export class GhCommandError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GhCommandError";
  }
}

function runGh(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8" });
  } catch (err) {
    const cause = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const stderr = typeof cause.stderr === "string" ? cause.stderr : cause.stderr?.toString("utf8");
    throw new GhCommandError(
      `gh ${args.join(" ")}`,
      stderr,
      stderr?.trim() || cause.message || "gh command failed",
    );
  }
}

export interface CreatePrInput {
  repoRoot: string;
  /** "owner/repo" — passed to `gh` explicitly rather than relying on a configured remote. */
  targetRepo: string;
  branchName: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface CreatePrResult {
  url: string;
}

export function createPr(input: CreatePrInput): CreatePrResult {
  const args = [
    "pr",
    "create",
    "--repo",
    input.targetRepo,
    "--head",
    input.branchName,
    "--title",
    input.title,
    "--body",
    input.body,
  ];
  if (input.draft) args.push("--draft");

  const output = runGh(input.repoRoot, args);
  // `gh pr create` prints the created PR's URL as the last line of stdout.
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const url = lines.at(-1);
  if (!url) {
    throw new GhCommandError(`gh ${args.join(" ")}`, output, "gh pr create produced no PR URL");
  }
  return { url };
}
