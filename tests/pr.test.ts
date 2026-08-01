import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { createPr, GhCommandError } = await import("../src/pr.js");

const BASE_INPUT = {
  repoRoot: "/repo",
  targetRepo: "org/repo",
  branchName: "qwen-task/abc-fix",
  title: "Reeve: fix the bug",
  body: "Full description here.",
};

describe("createPr", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("creates a ready-for-review PR without --draft, extracting the URL from stdout", () => {
    execFileSyncMock.mockReturnValueOnce(
      "Creating pull request...\nhttps://github.com/org/repo/pull/42\n",
    );

    const result = createPr({ ...BASE_INPUT, draft: false });

    expect(result).toEqual({ url: "https://github.com/org/repo/pull/42" });
    const [command, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("gh");
    expect(args).toEqual([
      "pr",
      "create",
      "--repo",
      "org/repo",
      "--head",
      "qwen-task/abc-fix",
      "--title",
      "Reeve: fix the bug",
      "--body",
      "Full description here.",
    ]);
    expect(args).not.toContain("--draft");
  });

  it("creates a draft PR when draft is true", () => {
    execFileSyncMock.mockReturnValueOnce("https://github.com/org/repo/pull/43\n");

    createPr({ ...BASE_INPUT, draft: true });

    const [, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("--draft");
    expect(args.at(-1)).toBe("--draft");
  });

  it("passes repoRoot as the child process cwd", () => {
    execFileSyncMock.mockReturnValueOnce("https://github.com/org/repo/pull/44\n");

    createPr({ ...BASE_INPUT, draft: false });

    const [, , options] = execFileSyncMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(options.cwd).toBe("/repo");
  });

  it("throws GhCommandError when the gh command itself fails", () => {
    const err = new Error("gh failed") as NodeJS.ErrnoException & { stderr: string };
    err.stderr = "GraphQL: Head branch already has an open pull request";
    execFileSyncMock.mockImplementationOnce(() => {
      throw err;
    });

    let caught: unknown;
    try {
      createPr({ ...BASE_INPUT, draft: false });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GhCommandError);
    expect((caught as InstanceType<typeof GhCommandError>).message).toMatch(
      /already has an open pull request/,
    );
  });

  it("throws GhCommandError when gh succeeds but prints no URL", () => {
    execFileSyncMock.mockReturnValueOnce("\n");

    expect(() => createPr({ ...BASE_INPUT, draft: false })).toThrow(/produced no PR URL/);
  });
});
