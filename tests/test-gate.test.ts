import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureTestBaseline, checkTestGate } from "../src/test-gate.js";

/** Writes a small CJS "test runner" script whose output/exit code are fully controlled by the test. */
function writeFakeTestRunner(dir: string, body: string): string {
  const scriptPath = join(dir, "run-tests.cjs");
  writeFileSync(scriptPath, body, "utf8");
  return `"${process.execPath}" "${scriptPath}"`;
}

describe("test-gate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reeve-test-gate-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures a clean baseline when the command exits 0 with no failure lines", () => {
    const testCommand = writeFakeTestRunner(
      dir,
      "console.log('PASS all good'); process.exit(0);\n",
    );

    const baseline = captureTestBaseline(testCommand, dir);

    expect(baseline.failingTests.size).toBe(0);
    const result = checkTestGate(baseline);
    expect(result).toEqual({ passed: true, regressedTests: [] });
  });

  it("does not flag a test that was already failing at baseline as a regression", () => {
    const testCommand = writeFakeTestRunner(
      dir,
      "console.log('FAIL known-flaky.test.ts'); process.exit(1);\n",
    );

    const baseline = captureTestBaseline(testCommand, dir);
    expect(baseline.failingTests.has("known-flaky.test.ts")).toBe(true);

    const result = checkTestGate(baseline);
    expect(result).toEqual({ passed: true, regressedTests: [] });
  });

  it("flags a newly-failing test as a regression", () => {
    const testCommand = writeFakeTestRunner(
      dir,
      `
      const fs = require("fs");
      const flagPath = process.argv[2] || "${join(dir, "broken.flag").replace(/\\/g, "\\\\")}";
      if (fs.existsSync(flagPath)) {
        console.log("FAIL bar.test.ts");
        process.exit(1);
      }
      process.exit(0);
      `,
    );
    const baseline = captureTestBaseline(testCommand, dir);
    expect(baseline.failingTests.size).toBe(0);

    writeFileSync(join(dir, "broken.flag"), "trigger the failure", "utf8");
    const result = checkTestGate(baseline);

    expect(result).toEqual({ passed: false, regressedTests: ["bar.test.ts"] });
  });

  it("recognizes vitest/mocha-style ✕ failure markers", () => {
    const testCommand = writeFakeTestRunner(
      dir,
      "console.log('  ✕ removes the unused variable'); process.exit(1);\n",
    );

    const baseline = captureTestBaseline(testCommand, dir);

    expect([...baseline.failingTests]).toEqual(["removes the unused variable"]);
  });

  it("throws when the test command itself can't be launched", () => {
    // A nonexistent cwd reliably fails at the spawn layer (ENOENT changing
    // directory) regardless of shell — a shell-reported "command not found"
    // is a normal nonzero exit, not a spawn error, so it doesn't exercise
    // this path.
    const nonexistentDir = join(dir, "does", "not", "exist");
    expect(() => captureTestBaseline("echo hi", nonexistentDir)).toThrow(
      /Failed to run test command/,
    );
  });
});
