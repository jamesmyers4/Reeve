/**
 * Baseline capture (once per task) + post-edit regression comparison. An
 * arbitrary shell `test_command` has no framework-agnostic structured
 * output, so "which tests failed" is approximated by scanning stdout+stderr
 * for lines matching common test-runner failure markers (jest/vitest,
 * mocha-style, TAP, pytest). This is a best-effort heuristic, not a real
 * parser — see CLAUDE.md for the tradeoffs.
 *
 * A test that's failing now but wasn't in the baseline's failing set is
 * treated as "passed at baseline, now fails" — a real regression — without
 * needing to enumerate every passing test, which no generic heuristic could
 * do reliably across frameworks anyway.
 */

import { spawnSync } from "node:child_process";
import type { TestGateResult } from "./types.js";

const TEST_COMMAND_TIMEOUT_MS = 120_000;

const FAILURE_LINE_PATTERNS = [
  /^FAIL\s+(.+)$/, // jest/vitest summary line: "FAIL src/foo.test.ts"
  /^\s*(?:✕|✗|×)\s+(.+)$/, // vitest/mocha/jest per-test failure marker
  /^not ok\s+\d+\s*-?\s*(.+)$/, // TAP
  /^(.+?)\s+FAILED\s*$/, // pytest: "test_foo.py::test_bar FAILED"
];

function extractFailingTestIds(output: string): Set<string> {
  const ids = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    for (const pattern of FAILURE_LINE_PATTERNS) {
      const match = line.match(pattern);
      if (match?.[1]) {
        ids.add(match[1].trim());
        break;
      }
    }
  }
  return ids;
}

function runTestCommand(testCommand: string, cwd: string): Set<string> {
  const result = spawnSync(testCommand, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: TEST_COMMAND_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(`Failed to run test command "${testCommand}": ${result.error.message}`);
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return extractFailingTestIds(output);
}

export interface TestGateBaseline {
  readonly testCommand: string;
  readonly cwd: string;
  readonly failingTests: ReadonlySet<string>;
}

/** Runs `test_command` once at task start. Throws if the command itself can't be launched — a misconfigured `test_command` is a setup problem, not a per-attempt gate failure. */
export function captureTestBaseline(testCommand: string, cwd: string): TestGateBaseline {
  return { testCommand, cwd, failingTests: runTestCommand(testCommand, cwd) };
}

/** Re-runs the baseline's `test_command` and diffs against its failing set. Any test failing now that wasn't failing at baseline is a regression. */
export function checkTestGate(baseline: TestGateBaseline): TestGateResult {
  const currentFailing = runTestCommand(baseline.testCommand, baseline.cwd);
  const regressedTests = [...currentFailing].filter((id) => !baseline.failingTests.has(id));
  return { passed: regressedTests.length === 0, regressedTests };
}
