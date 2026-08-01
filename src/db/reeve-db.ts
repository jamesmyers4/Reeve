/**
 * Reeve's SQLite layer. One accumulating file, reeve.sqlite, per Reeve
 * installation — never a fresh timestamped file per invocation.
 */

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
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
} from "../types.js";
import { migrate, migrations } from "./migrations.js";

export function newId(): string {
  return randomUUID();
}

interface TaskRow {
  id: string;
  description: string;
  target_repo: string;
  status: TaskStatus;
  branch_name: string | null;
  pr_url: string | null;
  created_at: number;
}

interface StepRow {
  id: string;
  task_id: string;
  step_index: number;
  instruction: string;
  file_path: string;
  status: StepStatus;
}

interface AttemptRow {
  id: string;
  step_id: string;
  attempt_number: number;
  kind: AttemptKind;
  file_content_before: string;
  file_content_after: string;
  structural_check_result_json: string | null;
  test_gate_result_json: string | null;
  verdict: Verdict;
  reasoning: string;
  cost_usd: number;
  created_at: number;
}

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    description: row.description,
    targetRepo: row.target_repo,
    status: row.status,
    ...(row.branch_name !== null && { branchName: row.branch_name }),
    ...(row.pr_url !== null && { prUrl: row.pr_url }),
    createdAt: row.created_at,
  };
}

function stepFromRow(row: StepRow): TaskStep {
  return {
    id: row.id,
    taskId: row.task_id,
    index: row.step_index,
    instruction: row.instruction,
    filePath: row.file_path,
    status: row.status,
  };
}

function attemptFromRow(row: AttemptRow): Attempt {
  return {
    id: row.id,
    stepId: row.step_id,
    attemptNumber: row.attempt_number,
    kind: row.kind,
    fileContentBefore: row.file_content_before,
    fileContentAfter: row.file_content_after,
    ...(row.structural_check_result_json !== null && {
      structuralCheckResult: JSON.parse(row.structural_check_result_json) as StructuralCheckResult,
    }),
    ...(row.test_gate_result_json !== null && {
      testGateResult: JSON.parse(row.test_gate_result_json) as TestGateResult,
    }),
    verdict: row.verdict,
    reasoning: row.reasoning,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
  };
}

export class ReeveDb {
  private readonly db: Database.Database;

  /** @param path SQLite file path, or ":memory:" for tests. */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    migrate(this.db, migrations);
  }

  close(): void {
    this.db.close();
  }

  // --- tasks ---

  insertTask(task: TaskRecord): void {
    this.db
      .prepare(
        "INSERT INTO tasks (id, description, target_repo, status, branch_name, pr_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        task.id,
        task.description,
        task.targetRepo,
        task.status,
        task.branchName ?? null,
        task.prUrl ?? null,
        task.createdAt,
      );
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  updateTaskStatus(id: string, status: TaskStatus): void {
    this.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
  }

  updateTaskBranch(id: string, branchName: string): void {
    this.db.prepare("UPDATE tasks SET branch_name = ? WHERE id = ?").run(branchName, id);
  }

  updateTaskPrUrl(id: string, prUrl: string): void {
    this.db.prepare("UPDATE tasks SET pr_url = ? WHERE id = ?").run(prUrl, id);
  }

  // --- steps ---

  insertStep(step: TaskStep): void {
    this.db
      .prepare(
        "INSERT INTO steps (id, task_id, step_index, instruction, file_path, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(step.id, step.taskId, step.index, step.instruction, step.filePath, step.status);
  }

  getStep(id: string): TaskStep | undefined {
    const row = this.db.prepare("SELECT * FROM steps WHERE id = ?").get(id) as StepRow | undefined;
    return row ? stepFromRow(row) : undefined;
  }

  listStepsForTask(taskId: string): TaskStep[] {
    const rows = this.db
      .prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY step_index")
      .all(taskId) as StepRow[];
    return rows.map(stepFromRow);
  }

  updateStepStatus(id: string, status: StepStatus): void {
    this.db.prepare("UPDATE steps SET status = ? WHERE id = ?").run(status, id);
  }

  // --- attempts ---

  insertAttempt(attempt: Attempt): void {
    this.db
      .prepare(
        `INSERT INTO attempts (
          id, step_id, attempt_number, kind, file_content_before, file_content_after,
          structural_check_result_json, test_gate_result_json, verdict, reasoning, cost_usd, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.stepId,
        attempt.attemptNumber,
        attempt.kind,
        attempt.fileContentBefore,
        attempt.fileContentAfter,
        attempt.structuralCheckResult !== undefined
          ? JSON.stringify(attempt.structuralCheckResult)
          : null,
        attempt.testGateResult !== undefined ? JSON.stringify(attempt.testGateResult) : null,
        attempt.verdict,
        attempt.reasoning,
        attempt.costUsd,
        attempt.createdAt,
      );
  }

  listAttemptsForStep(stepId: string): Attempt[] {
    const rows = this.db
      .prepare("SELECT * FROM attempts WHERE step_id = ? ORDER BY attempt_number")
      .all(stepId) as AttemptRow[];
    return rows.map(attemptFromRow);
  }
}
