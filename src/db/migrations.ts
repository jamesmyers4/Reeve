/**
 * Versioned, forward-only migrations for reeve.sqlite. Each entry runs once
 * inside a transaction; applied versions are recorded in `schema_migrations`
 * so reopening an existing file is a no-op re-migration.
 *
 * Mirrors Drover's DroverDb/SqliteStore migration-runner shape.
 */

import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "core-tables",
    sql: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        target_repo TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'escalated', 'escalated-preflight')),
        branch_name TEXT,
        pr_url TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        step_index INTEGER NOT NULL,
        instruction TEXT NOT NULL,
        file_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'passed', 'escalated'))
      );
      CREATE INDEX idx_steps_task ON steps(task_id, step_index);

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL REFERENCES steps(id),
        attempt_number INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('structural-check', 'test-gate', 'review')),
        file_content_before TEXT NOT NULL,
        file_content_after TEXT NOT NULL,
        structural_check_result_json TEXT,
        test_gate_result_json TEXT,
        verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'revise', 'escalate')),
        reasoning TEXT NOT NULL,
        cost_usd REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_attempts_step ON attempts(step_id, attempt_number);
    `,
  },
];

/** Applies every migration not yet recorded in `schema_migrations`, in order, each in its own transaction. */
export function migrate(db: Database.Database, migrationList: Migration[] = migrations): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((r) => (r as { version: number }).version),
  );
  for (const m of migrationList) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        Date.now(),
      );
    })();
  }
}
