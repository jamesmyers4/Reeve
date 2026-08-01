import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, ReeveDb } from "../src/db/reeve-db.js";
import type { Attempt, TaskRecord, TaskStep } from "../src/types.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: newId(),
    description: "Remove the unused `foo` variable on line 12 of bar.ts",
    targetRepo: "jamesmyers4/some-target-repo",
    status: "pending",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeStep(taskId: string, overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: newId(),
    taskId,
    index: 0,
    instruction: "Delete the unused `foo` variable on line 12.",
    filePath: "src/bar.ts",
    status: "pending",
    ...overrides,
  };
}

function makeAttempt(stepId: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: newId(),
    stepId,
    attemptNumber: 1,
    kind: "review",
    fileContentBefore: "const foo = 1;\nexport function bar() {}\n",
    fileContentAfter: "export function bar() {}\n",
    verdict: "pass",
    reasoning: "Removed the unused variable exactly as instructed, nothing else changed.",
    costUsd: 0.0042,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("ReeveDb", () => {
  let db: ReeveDb;

  beforeEach(() => {
    db = new ReeveDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("migrates cleanly on an empty database", () => {
    const fresh = new ReeveDb(":memory:");
    fresh.close();
  });

  it("round-trips a task", () => {
    const task = makeTask();
    db.insertTask(task);
    expect(db.getTask(task.id)).toEqual(task);
  });

  it("round-trips a task with a branch name and PR URL", () => {
    const task = makeTask({
      status: "passed",
      branchName: "qwen-task/abc123-remove-foo",
      prUrl: "https://github.com/jamesmyers4/some-target-repo/pull/1",
    });
    db.insertTask(task);
    expect(db.getTask(task.id)).toEqual(task);
  });

  it("updates task status, branch name, and PR URL independently", () => {
    const task = makeTask();
    db.insertTask(task);

    db.updateTaskStatus(task.id, "running");
    expect(db.getTask(task.id)?.status).toBe("running");

    db.updateTaskBranch(task.id, "qwen-task/abc123-remove-foo");
    expect(db.getTask(task.id)?.branchName).toBe("qwen-task/abc123-remove-foo");

    db.updateTaskPrUrl(task.id, "https://github.com/jamesmyers4/some-target-repo/pull/1");
    expect(db.getTask(task.id)?.prUrl).toBe(
      "https://github.com/jamesmyers4/some-target-repo/pull/1",
    );
  });

  it("round-trips a step and lists a task's steps in index order", () => {
    const task = makeTask();
    db.insertTask(task);
    const stepB = makeStep(task.id, { index: 1, filePath: "src/b.ts" });
    const stepA = makeStep(task.id, { index: 0, filePath: "src/a.ts" });
    db.insertStep(stepB);
    db.insertStep(stepA);

    expect(db.getStep(stepA.id)).toEqual(stepA);
    expect(db.listStepsForTask(task.id)).toEqual([stepA, stepB]);
  });

  it("updates step status", () => {
    const task = makeTask();
    db.insertTask(task);
    const step = makeStep(task.id);
    db.insertStep(step);

    db.updateStepStatus(step.id, "passed");
    expect(db.getStep(step.id)?.status).toBe("passed");
  });

  it("round-trips an attempt, including structural-check and test-gate results", () => {
    const task = makeTask();
    db.insertTask(task);
    const step = makeStep(task.id);
    db.insertStep(step);

    const attempt = makeAttempt(step.id, {
      kind: "structural-check",
      verdict: "revise",
      structuralCheckResult: { passed: false, reason: "output was empty" },
      testGateResult: { passed: false, regressedTests: ["bar.test.ts > removes foo"] },
    });
    db.insertAttempt(attempt);

    expect(db.listAttemptsForStep(step.id)).toEqual([attempt]);
  });

  it("round-trips an attempt with no structural-check or test-gate result", () => {
    const task = makeTask();
    db.insertTask(task);
    const step = makeStep(task.id);
    db.insertStep(step);

    const attempt = makeAttempt(step.id);
    db.insertAttempt(attempt);

    expect(db.listAttemptsForStep(step.id)).toEqual([attempt]);
  });

  it("orders multiple attempts for a step by attempt number", () => {
    const task = makeTask();
    db.insertTask(task);
    const step = makeStep(task.id);
    db.insertStep(step);

    const attempt2 = makeAttempt(step.id, { attemptNumber: 2, verdict: "escalate" });
    const attempt1 = makeAttempt(step.id, { attemptNumber: 1, verdict: "revise" });
    db.insertAttempt(attempt2);
    db.insertAttempt(attempt1);

    expect(db.listAttemptsForStep(step.id)).toEqual([attempt1, attempt2]);
  });
});

describe("ReeveDb file persistence", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reeve-db-test-"));
    dbPath = join(dir, "reeve.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reopening an existing database file is a no-op re-migration", () => {
    const first = new ReeveDb(dbPath);
    const task = makeTask();
    first.insertTask(task);
    first.close();
    expect(existsSync(dbPath)).toBe(true);

    // If migrate() re-ran the CREATE TABLE statements against the same file,
    // this constructor call would throw ("table tasks already exists").
    const second = new ReeveDb(dbPath);
    expect(second.getTask(task.id)).toEqual(task);
    second.close();
  });

  it("does not duplicate schema_migrations rows across reopens", () => {
    const first = new ReeveDb(dbPath);
    first.close();

    const second = new ReeveDb(dbPath);
    const task = makeTask();
    second.insertTask(task);
    second.close();

    const third = new ReeveDb(dbPath);
    expect(third.getTask(task.id)).toEqual(task);
    third.close();
  });
});
