import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const {
  branchNameForTask,
  commitStep,
  createTaskBranch,
  currentCommitSha,
  diffStat,
  GitCommandError,
  pushTaskBranch,
} = await import("../src/git.js");
const { newId } = await import("../src/db/reeve-db.js");

import type { TaskRecord, TaskStep } from "../src/types.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: newId(),
    description: "Remove the unused foo variable",
    targetRepo: "org/repo",
    status: "passed",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeStep(taskId: string, overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: newId(),
    taskId,
    index: 0,
    instruction: "Delete the unused foo variable.",
    filePath: "src/bar.ts",
    status: "passed",
    ...overrides,
  };
}

describe("branchNameForTask", () => {
  it("builds qwen-task/<short-id>-<slug>", () => {
    const task = makeTask({
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      description: "Remove dead code",
    });
    expect(branchNameForTask(task)).toBe("qwen-task/abcdef12-remove-dead-code");
  });

  it("slugifies punctuation and collapses repeated separators", () => {
    const task = makeTask({
      id: "11111111-0000-0000-0000-000000000000",
      description: "Fix: the bug!! (again)",
    });
    expect(branchNameForTask(task)).toBe("qwen-task/11111111-fix-the-bug-again");
  });

  it("truncates a very long description's slug", () => {
    const task = makeTask({
      id: "22222222-0000-0000-0000-000000000000",
      description: "a".repeat(200),
    });
    const branch = branchNameForTask(task);
    expect(branch.startsWith("qwen-task/22222222-")).toBe(true);
    expect(branch.length).toBeLessThan(70);
  });

  it("falls back to a literal slug when the description has no sluggable characters", () => {
    const task = makeTask({ id: "33333333-0000-0000-0000-000000000000", description: "!!!" });
    expect(branchNameForTask(task)).toBe("qwen-task/33333333-task");
  });
});

describe("git command wrappers", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("createTaskBranch runs git checkout -b", () => {
    execFileSyncMock.mockReturnValueOnce("");
    createTaskBranch("/repo", "qwen-task/abc-fix");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "qwen-task/abc-fix"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("commitStep stages exactly the step's file and commits with the instruction as the message", () => {
    execFileSyncMock.mockReturnValueOnce("").mockReturnValueOnce("");
    const step = makeStep("task-1");

    commitStep("/repo", step);

    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["add", "--", "src/bar.ts"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      2,
      "git",
      ["commit", "-m", "Delete the unused foo variable."],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("pushTaskBranch pushes to an authenticated x-access-token URL", () => {
    execFileSyncMock.mockReturnValueOnce("");
    pushTaskBranch("/repo", "org/repo", "qwen-task/abc-fix", "ghp_supersecret");

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      [
        "push",
        "https://x-access-token:ghp_supersecret@github.com/org/repo.git",
        "qwen-task/abc-fix",
      ],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("redacts the PAT from a thrown GitCommandError, even in the reconstructed command string", () => {
    const err = new Error("push failed") as NodeJS.ErrnoException & { stderr: string };
    err.stderr =
      "remote: Invalid credentials for https://x-access-token:ghp_supersecret@github.com/org/repo.git";
    execFileSyncMock.mockImplementationOnce(() => {
      throw err;
    });

    let caught: unknown;
    try {
      pushTaskBranch("/repo", "org/repo", "qwen-task/abc-fix", "ghp_supersecret");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(GitCommandError);
    const gitErr = caught as InstanceType<typeof GitCommandError>;
    expect(gitErr.message).not.toContain("ghp_supersecret");
    expect(gitErr.command).not.toContain("ghp_supersecret");
    expect(gitErr.stderr).not.toContain("ghp_supersecret");
    expect(gitErr.message).toContain("***");
  });

  it("wraps a plain git failure (no PAT involved) in GitCommandError with the real stderr", () => {
    const err = new Error("fatal") as NodeJS.ErrnoException & { stderr: string };
    err.stderr = "fatal: a branch named 'qwen-task/abc-fix' already exists";
    execFileSyncMock.mockImplementationOnce(() => {
      throw err;
    });

    let caught: unknown;
    try {
      createTaskBranch("/repo", "qwen-task/abc-fix");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    expect((caught as InstanceType<typeof GitCommandError>).message).toMatch(/already exists/);
  });

  it("currentCommitSha trims the rev-parse output", () => {
    execFileSyncMock.mockReturnValueOnce("abc123def456\n");
    expect(currentCommitSha("/repo")).toBe("abc123def456");
  });

  it("diffStat runs git diff --stat against the base ref", () => {
    execFileSyncMock.mockReturnValueOnce(
      " src/bar.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n",
    );
    const result = diffStat("/repo", "abc123");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["diff", "--stat", "abc123..HEAD"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(result).toMatch(/1 file changed/);
  });
});
