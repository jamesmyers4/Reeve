import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStructuralCheck } from "../src/structural-check.js";

describe("runStructuralCheck", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reeve-structural-check-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails when the rewritten content is empty", () => {
    const result = runStructuralCheck(join(dir, "foo.ts"), "");
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  it("fails when the rewritten content is only whitespace", () => {
    const result = runStructuralCheck(join(dir, "foo.ts"), "   \n\t\n");
    expect(result.passed).toBe(false);
  });

  it("passes syntactically valid TypeScript", () => {
    const result = runStructuralCheck(
      join(dir, "foo.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    expect(result).toEqual({ passed: true });
  });

  it("fails TypeScript with a real syntax error, and includes the compiler's diagnostic", () => {
    const result = runStructuralCheck(
      join(dir, "foo.ts"),
      "export function broken(a: number { return a; }\n",
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/error TS\d+/);
  });

  it("passes syntactically valid JavaScript", () => {
    const result = runStructuralCheck(
      join(dir, "foo.js"),
      "function add(a, b) {\n  return a + b;\n}\n",
    );
    expect(result).toEqual({ passed: true });
  });

  it("fails JavaScript with a real syntax error", () => {
    const result = runStructuralCheck(join(dir, "foo.js"), "function broken(a { return a; }\n");
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/SyntaxError/);
  });

  it("skips silently for an extension with no cheap checker known", () => {
    const result = runStructuralCheck(
      join(dir, "notes.md"),
      "# whatever content, even nonsense {[<\n",
    );
    expect(result).toEqual({ passed: true });
  });

  it("does not leave a temp check file behind", () => {
    runStructuralCheck(join(dir, "foo.js"), "const x = 1;\n");
    expect(readdirSync(dir)).toEqual([]);
  });
});
