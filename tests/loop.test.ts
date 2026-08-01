import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskBudget } from "../src/budget.js";
import { ReeveDb } from "../src/db/reeve-db.js";
import { MAX_ATTEMPTS_PER_STEP, type RunTaskContext, runTask } from "../src/loop.js";
import { ScriptedExecutor } from "../src/providers/executor.js";
import { ScriptedReviewer } from "../src/providers/reviewer.js";
import { ScriptedTaskAuthor } from "../src/providers/task-author.js";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";

function baseCtx(fixture: FixtureRepo, overrides: Partial<RunTaskContext> = {}): RunTaskContext {
  return {
    db: new ReeveDb(":memory:"),
    taskAuthor: new ScriptedTaskAuthor([]),
    executor: new ScriptedExecutor([]),
    reviewer: new ScriptedReviewer([]),
    budget: new TaskBudget(10),
    repoRoot: fixture.root,
    ...overrides,
  };
}

describe("runTask", () => {
  let fixture: FixtureRepo;

  beforeEach(() => {
    fixture = createFixtureRepo({
      "a.txt": "before A\n",
      "b.txt": "before B\n",
      "c.txt": "before C\n",
    });
  });

  afterEach(() => {
    fixture.close();
  });

  it("passes a clean multi-step task end to end", async () => {
    const ctx = baseCtx(fixture, {
      taskAuthor: new ScriptedTaskAuthor([
        {
          escalate: false,
          steps: [
            { instruction: "edit a", filePath: "a.txt" },
            { instruction: "edit b", filePath: "b.txt" },
          ],
        },
      ]),
      executor: new ScriptedExecutor(["after A\n", "after B\n"]),
      reviewer: new ScriptedReviewer([
        { verdict: "pass", reasoning: "matches the instruction" },
        { verdict: "pass", reasoning: "matches the instruction" },
      ]),
    });

    const task = await runTask({ description: "edit a and b", targetRepo: "org/repo" }, ctx);

    expect(task.status).toBe("passed");
    expect(ctx.db.getTask(task.id)?.status).toBe("passed");

    const steps = ctx.db.listStepsForTask(task.id);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.status === "passed")).toBe(true);

    expect(fixture.readFile("a.txt")).toBe("after A\n");
    expect(fixture.readFile("b.txt")).toBe("after B\n");

    for (const step of steps) {
      const attempts = ctx.db.listAttemptsForStep(step.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.kind).toBe("review");
      expect(attempts[0]?.verdict).toBe("pass");
    }
  });

  it("passes a step after one revision", async () => {
    const ctx = baseCtx(fixture, {
      taskAuthor: new ScriptedTaskAuthor([
        { escalate: false, steps: [{ instruction: "fix a", filePath: "a.txt" }] },
      ]),
      executor: new ScriptedExecutor(["attempt one\n", "attempt two\n"]),
      reviewer: new ScriptedReviewer([
        {
          verdict: "revise",
          reasoning: "close but not quite",
          revisedInstruction: "try again, more precisely",
        },
        { verdict: "pass", reasoning: "correct now" },
      ]),
    });

    const task = await runTask({ description: "fix a", targetRepo: "org/repo" }, ctx);

    expect(task.status).toBe("passed");
    const [step] = ctx.db.listStepsForTask(task.id);
    expect(step?.status).toBe("passed");
    expect(fixture.readFile("a.txt")).toBe("attempt two\n");

    const attempts = ctx.db.listAttemptsForStep(step?.id ?? "");
    expect(attempts.map((a) => a.verdict)).toEqual(["revise", "pass"]);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
  });

  it("escalates a step that exhausts all 3 attempts, retaining earlier passed steps and never attempting later ones", async () => {
    const ctx = baseCtx(fixture, {
      taskAuthor: new ScriptedTaskAuthor([
        {
          escalate: false,
          steps: [
            { instruction: "edit a", filePath: "a.txt" },
            { instruction: "edit b", filePath: "b.txt" },
            { instruction: "edit c", filePath: "c.txt" },
          ],
        },
      ]),
      executor: new ScriptedExecutor([
        "after A\n",
        "b attempt 1\n",
        "b attempt 2\n",
        "b attempt 3\n",
      ]),
      reviewer: new ScriptedReviewer([
        { verdict: "pass", reasoning: "step A is correct" },
        { verdict: "revise", reasoning: "no good", revisedInstruction: "retry 1" },
        { verdict: "revise", reasoning: "still no good", revisedInstruction: "retry 2" },
        { verdict: "revise", reasoning: "still not right", revisedInstruction: "retry 3" },
      ]),
    });

    const task = await runTask({ description: "edit a, b, c", targetRepo: "org/repo" }, ctx);

    expect(task.status).toBe("escalated");

    const steps = ctx.db.listStepsForTask(task.id);
    // Step C was never attempted, and never even inserted.
    expect(steps).toHaveLength(2);
    const [stepA, stepB] = steps;
    expect(stepA?.status).toBe("passed");
    expect(stepB?.status).toBe("escalated");

    // No rollback of the step that already passed.
    expect(fixture.readFile("a.txt")).toBe("after A\n");
    // The escalated step's own edit never lands.
    expect(fixture.readFile("b.txt")).toBe("before B\n");
    // The never-attempted step's file is untouched.
    expect(fixture.readFile("c.txt")).toBe("before C\n");

    const stepBAttempts = ctx.db.listAttemptsForStep(stepB?.id ?? "");
    expect(stepBAttempts).toHaveLength(MAX_ATTEMPTS_PER_STEP);
    expect(stepBAttempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    // The reviewer's own literal verdict is recorded even on the last
    // attempt — "escalated" is the step's outcome, not a rewritten verdict.
    expect(stepBAttempts.every((a) => a.verdict === "revise")).toBe(true);
  });

  it("escalates pre-flight when the task-author bails, without ever calling the executor", async () => {
    const ctx = baseCtx(fixture, {
      taskAuthor: new ScriptedTaskAuthor([
        { escalate: true, reason: "the task doesn't say which file to edit" },
      ]),
      // An empty script throws immediately if rewrite() is ever called —
      // proving zero executor calls were made.
      executor: new ScriptedExecutor([]),
      reviewer: new ScriptedReviewer([]),
    });

    const task = await runTask({ description: "do something vague", targetRepo: "org/repo" }, ctx);

    expect(task.status).toBe("escalated-preflight");
    expect(ctx.db.getTask(task.id)?.status).toBe("escalated-preflight");
    expect(ctx.db.listStepsForTask(task.id)).toHaveLength(0);
  });

  it("forces revise on a test-gate regression even though the scripted reviewer would have said pass", async () => {
    fixture.writeFile("bar.txt", "safe content\n");
    fixture.writeFile(
      "check.cjs",
      [
        'const fs = require("fs");',
        'const content = fs.readFileSync("bar.txt", "utf8");',
        'if (content.includes("BROKEN")) {',
        '  console.log("FAIL bar.test.ts");',
        "  process.exit(1);",
        "}",
        "process.exit(0);",
      ].join("\n"),
    );

    const ctx = baseCtx(fixture, {
      taskAuthor: new ScriptedTaskAuthor([
        { escalate: false, steps: [{ instruction: "touch bar", filePath: "bar.txt" }] },
      ]),
      executor: new ScriptedExecutor(["BROKEN content\n", "safe fixed content\n"]),
      // Configured to always say pass — proving the test-gate regression,
      // not the reviewer's own judgment, is what forces the first revise.
      reviewer: new ScriptedReviewer([
        { verdict: "pass", reasoning: "looks fine to me" },
        { verdict: "pass", reasoning: "looks fine to me" },
      ]),
      testCommand: `"${process.execPath}" "${join(fixture.root, "check.cjs")}"`,
    });

    const task = await runTask(
      { description: "touch bar without breaking it", targetRepo: "org/repo" },
      ctx,
    );

    expect(task.status).toBe("passed");
    expect(fixture.readFile("bar.txt")).toBe("safe fixed content\n");

    const [step] = ctx.db.listStepsForTask(task.id);
    const attempts = ctx.db.listAttemptsForStep(step?.id ?? "");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ kind: "test-gate", verdict: "revise" });
    expect(attempts[1]).toMatchObject({ kind: "review", verdict: "pass" });
  });

  it("never lets a review call happen once the task budget ceiling is reached", async () => {
    const ctx = baseCtx(fixture, {
      // Costs exactly the whole ceiling — decompose itself is allowed
      // through (spend starts at 0), but leaves no room for the review call.
      taskAuthor: new ScriptedTaskAuthor(
        [{ escalate: false, steps: [{ instruction: "edit a", filePath: "a.txt" }] }],
        5,
      ),
      executor: new ScriptedExecutor(["after A\n"]),
      // Would throw "script exhausted" if it were ever reached — proving the
      // budget check stops the call before the reviewer runs, not after.
      reviewer: new ScriptedReviewer([]),
      budget: new TaskBudget(5),
    });

    await expect(runTask({ description: "edit a", targetRepo: "org/repo" }, ctx)).rejects.toThrow(
      /Task budget ceiling exceeded/,
    );
    // The decompose call was allowed through before the ceiling was hit.
    expect(ctx.budget.spent).toBe(5);
  });
});
