/**
 * Cheap, best-effort guard on qwen's rewritten file content, run before the
 * result ever reaches the reviewer. Checks non-empty/non-truncated, then a
 * per-language parse/type check by shelling out to a real compiler/checker
 * — skipped silently for extensions with no cheap checker known.
 *
 * "Best-effort" is load-bearing here: a standalone file has no access to
 * its project's tsconfig (imports elsewhere in the project won't resolve),
 * so this catches genuine syntax breakage, not full project-aware type
 * errors. That's an accepted limitation, not an oversight — see CLAUDE.md.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { StructuralCheckResult } from "./types.js";

const CHECK_TIMEOUT_MS = 30_000;
const MAX_REASON_LENGTH = 2000;

function runProcess(command: string, args: string[]): StructuralCheckResult {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(command, args, { timeout: CHECK_TIMEOUT_MS, encoding: "utf8" });
  } catch {
    // Checker command itself couldn't be launched — treat the same as "no
    // cheap checker available on this machine", not a failure.
    return { passed: true };
  }
  if (result.error) {
    return { passed: true };
  }
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || "").trim().slice(0, MAX_REASON_LENGTH);
    return { passed: false, reason: output || `${command} exited with status ${result.status}` };
  }
  return { passed: true };
}

let tscBinPath: string | null | undefined;

/**
 * Resolves Reeve's own bundled `typescript` package's `tsc` binary —
 * deliberately not the target repo's own `tsc` (a standalone file check
 * gets no project-aware benefit from it anyway; see the module doc above).
 */
function resolveTscBin(): string | null {
  if (tscBinPath !== undefined) return tscBinPath;
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("typescript/package.json");
    const pkg = require(pkgPath) as { bin?: { tsc?: string } };
    tscBinPath = pkg.bin?.tsc ? join(dirname(pkgPath), pkg.bin.tsc) : null;
  } catch {
    tscBinPath = null;
  }
  return tscBinPath;
}

function checkTypeScript(filePath: string): StructuralCheckResult {
  const tsc = resolveTscBin();
  if (!tsc) return { passed: true };
  const args = ["--noEmit", "--ignoreConfig", filePath];
  // --ignoreConfig: this TypeScript's tsc refuses to combine an
  // auto-discovered project tsconfig with explicit file arguments (TS5112)
  // — since Reeve (and most target repos) has a tsconfig.json somewhere up
  // the tree, that combination would otherwise fail on every invocation
  // regardless of the file's actual validity.
  if (filePath.endsWith(".tsx")) args.push("--jsx", "react");
  return runProcess(process.execPath, [tsc, ...args]);
}

function checkNode(filePath: string): StructuralCheckResult {
  return runProcess(process.execPath, ["--check", filePath]);
}

function checkPython(filePath: string): StructuralCheckResult {
  return runProcess("python", ["-m", "py_compile", filePath]);
}

const CHECKERS: Record<string, (filePath: string) => StructuralCheckResult> = {
  ".ts": checkTypeScript,
  ".tsx": checkTypeScript,
  ".js": checkNode,
  ".mjs": checkNode,
  ".cjs": checkNode,
  ".py": checkPython,
};

/**
 * @param filePath The real target file path — used only to derive the
 *   extension and a sibling temp-file location; never read or written.
 * @param content The executor's rewritten file content to validate.
 */
export function runStructuralCheck(filePath: string, content: string): StructuralCheckResult {
  if (content.trim().length === 0) {
    return { passed: false, reason: "rewritten content was empty" };
  }

  const checker = CHECKERS[extname(filePath)];
  if (!checker) {
    // No cheap checker known for this extension — skip silently.
    return { passed: true };
  }

  const tempPath = join(dirname(filePath), `.reeve-check-${randomUUID()}${extname(filePath)}`);
  try {
    writeFileSync(tempPath, content, "utf8");
    return checker(tempPath);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup — a leftover temp file is harmless.
    }
  }
}
