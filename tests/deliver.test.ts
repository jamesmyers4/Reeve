import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { sendMock, ResendMock } = vi.hoisted(() => {
  const sendMock = vi.fn().mockResolvedValue({ data: { id: "email_123" }, error: null });
  const ResendMock = vi.fn().mockImplementation(function MockResend(this: { emails: unknown }) {
    this.emails = { send: sendMock };
  });
  return { sendMock, ResendMock };
});
vi.mock("resend", () => ({ Resend: ResendMock }));

// notify.ts reads RESEND_API_KEY once, at module-evaluation time — set it
// before the dynamic import below so the mocked Resend client is actually
// constructed, rather than notify.ts's no-key no-op path. Restored after
// this file's tests run so it doesn't leak into other test files sharing
// the same worker (see the afterAll below).
const originalResendApiKey = process.env.RESEND_API_KEY;
process.env.RESEND_API_KEY = "re_test_key";

const { deliverTaskOutcome } = await import("../src/deliver.js");
const { ReeveDb, newId } = await import("../src/db/reeve-db.js");

import type { RunTaskResult } from "../src/loop.js";
import type { Attempt, TaskStep } from "../src/types.js";

const PR_URL = "https://github.com/org/repo/pull/99";

function gitAndGhMock(cmd: string, args: string[]): string {
  if (cmd === "git" && args[0] === "rev-parse") return "abc123\n";
  if (cmd === "git" && args[0] === "diff")
    return " src/bar.ts | 1 +\n 1 file changed, 1 insertion(+)\n";
  if (cmd === "gh" && args[0] === "pr") return `${PR_URL}\n`;
  return "";
}

function makeTask(overrides: Partial<RunTaskResult> = {}): RunTaskResult {
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

function makeAttempt(stepId: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: newId(),
    stepId,
    attemptNumber: 1,
    kind: "review",
    fileContentBefore: "before",
    fileContentAfter: "after",
    verdict: "pass",
    reasoning: "Matches the instruction.",
    costUsd: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

function gitArgCalls(): string[][] {
  return execFileSyncMock.mock.calls
    .filter(([cmd]) => cmd === "git")
    .map(([, args]) => args as string[]);
}

function ghArgCalls(): string[][] {
  return execFileSyncMock.mock.calls
    .filter(([cmd]) => cmd === "gh")
    .map(([, args]) => args as string[]);
}

describe("deliverTaskOutcome", () => {
  let db: InstanceType<typeof ReeveDb>;

  afterAll(() => {
    if (originalResendApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalResendApiKey;
    }
  });

  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(gitAndGhMock);
    sendMock.mockClear();
    db = new ReeveDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("full pass: pushes a branch with a commit per passed step, opens a ready-for-review PR, sends the final-pass email", async () => {
    const task = makeTask({ status: "passed" });
    db.insertTask(task);
    const stepA = makeStep(task.id, { index: 0, filePath: "a.ts", status: "passed" });
    const stepB = makeStep(task.id, { index: 1, filePath: "b.ts", status: "passed" });
    db.insertStep(stepA);
    db.insertStep(stepB);

    const result = await deliverTaskOutcome(task, {
      db,
      repoRoot: "/repo",
      pat: "ghp_test",
      notifyEmail: "me@example.test",
    });

    expect(result.prUrl).toBe(PR_URL);
    expect(result.branchName).toMatch(/^qwen-task\//);

    const git = gitArgCalls();
    expect(git[0]).toEqual(["rev-parse", "HEAD"]);
    expect(git.some((a) => a[0] === "checkout" && a[1] === "-b")).toBe(true);
    // One add+commit pair per passed step, in order.
    expect(git.filter((a) => a[0] === "add")).toEqual([
      ["add", "--", "a.ts"],
      ["add", "--", "b.ts"],
    ]);
    expect(git.filter((a) => a[0] === "commit").map((a) => a[2])).toEqual([
      stepA.instruction,
      stepB.instruction,
    ]);
    expect(git.some((a) => a[0] === "push")).toBe(true);
    expect(git.some((a) => a[0] === "diff")).toBe(true);

    const gh = ghArgCalls();
    expect(gh).toHaveLength(1);
    expect(gh[0]).not.toContain("--draft");
    const body = gh[0]?.[gh[0].indexOf("--body") + 1] ?? "";
    expect(body).toContain("a.ts");
    expect(body).toMatch(/1 file changed/); // diff summary made it into the body

    expect(sendMock).toHaveBeenCalledTimes(1);
    const emailArg = sendMock.mock.calls[0]?.[0] as { subject: string; text: string };
    expect(emailArg.subject).toMatch(/passed/);
    expect(emailArg.text).toContain(PR_URL);

    // Persisted back onto the task row.
    expect(db.getTask(task.id)?.branchName).toBe(result.branchName);
    expect(db.getTask(task.id)?.prUrl).toBe(PR_URL);
  });

  it("step escalation: commits only the passed steps, opens a draft PR, sends the escalation email with the last attempt's reasoning and the PR link", async () => {
    const task = makeTask({ status: "escalated" });
    db.insertTask(task);
    const stepA = makeStep(task.id, { index: 0, filePath: "a.ts", status: "passed" });
    const stepB = makeStep(task.id, { index: 1, filePath: "b.ts", status: "escalated" });
    db.insertStep(stepA);
    db.insertStep(stepB);
    // Only the LAST attempt's reasoning/output should ever reach the PR
    // description (CONTEXT.md: "its last attempt's reasoning + test/structural
    // output verbatim") — attempt 1's own reasoning should not appear.
    db.insertAttempt(
      makeAttempt(stepB.id, {
        attemptNumber: 1,
        kind: "review",
        verdict: "revise",
        reasoning: "First attempt left the wrong variable in place.",
      }),
    );
    db.insertAttempt(
      makeAttempt(stepB.id, {
        attemptNumber: 2,
        kind: "structural-check",
        verdict: "escalate",
        reasoning: "unexpected token",
        structuralCheckResult: { passed: false, reason: "unexpected token" },
      }),
    );

    const result = await deliverTaskOutcome(task, {
      db,
      repoRoot: "/repo",
      pat: "ghp_test",
      notifyEmail: "me@example.test",
    });

    expect(result.prUrl).toBe(PR_URL);

    const git = gitArgCalls();
    // Only the passed step is committed — the escalated step's edit never landed.
    expect(git.filter((a) => a[0] === "add")).toEqual([["add", "--", "a.ts"]]);
    expect(git.some((a) => a[0] === "diff")).toBe(false); // no diff summary on a non-full-pass

    const gh = ghArgCalls();
    expect(gh).toHaveLength(1);
    expect(gh[0]).toContain("--draft");
    const body = gh[0]?.[gh[0].indexOf("--body") + 1] ?? "";
    expect(body).toContain("a.ts"); // marked safe
    expect(body).toContain("unexpected token"); // last attempt's reasoning + structural output, verbatim
    expect(body).not.toContain("First attempt left the wrong variable in place."); // only the last attempt, not the whole history

    expect(sendMock).toHaveBeenCalledTimes(1);
    const emailArg = sendMock.mock.calls[0]?.[0] as { subject: string; text: string };
    expect(emailArg.subject).toMatch(/escalated/);
    expect(emailArg.text).toContain(PR_URL);
    expect(emailArg.text).toContain("unexpected token");
  });

  it("pre-flight escalation: makes no git or gh calls at all, sends the escalation email with the task-author's reason and no PR link", async () => {
    const task = makeTask({
      status: "escalated-preflight",
      preflightReason: "The task doesn't say which file to edit.",
    });
    db.insertTask(task);

    const result = await deliverTaskOutcome(task, {
      db,
      repoRoot: "/repo",
      pat: "ghp_test",
      notifyEmail: "me@example.test",
    });

    expect(result).toEqual({});
    expect(execFileSyncMock).not.toHaveBeenCalled();

    expect(sendMock).toHaveBeenCalledTimes(1);
    const emailArg = sendMock.mock.calls[0]?.[0] as { subject: string; text: string };
    expect(emailArg.subject).toMatch(/escalated/);
    expect(emailArg.text).not.toMatch(/pull\//);
    expect(emailArg.text).toContain("The task doesn't say which file to edit.");

    // Nothing to persist — the task row's branch/PR fields stay unset.
    expect(db.getTask(task.id)?.branchName).toBeUndefined();
    expect(db.getTask(task.id)?.prUrl).toBeUndefined();
  });
});
