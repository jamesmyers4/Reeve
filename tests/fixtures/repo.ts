/**
 * A real, throwaway local git repo for integration tests — mirrors Drover's
 * `tests/fixtures/site.ts` precedent (a real disposable target rather than
 * full mocking), adapted from an in-process HTTP server to a temp-dir git
 * working tree since that's what Reeve's loop actually edits.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FixtureRepo {
  /** Absolute path to the working tree's root. */
  root: string;
  writeFile(relativePath: string, content: string): void;
  readFile(relativePath: string): string;
  close(): void;
}

const DEFAULT_SEED_FILES: Record<string, string> = {
  "README.md": "# fixture repo\n",
};

export function createFixtureRepo(
  seedFiles: Record<string, string> = DEFAULT_SEED_FILES,
): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "reeve-fixture-repo-"));

  function writeFile(relativePath: string, content: string): void {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }

  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "reeve-test@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Reeve Test"], { cwd: root });
  // Fixture files are read/written directly via node:fs, never through git,
  // so line-ending conversion has no effect here — disable it locally to
  // silence the host's global autocrlf warning noise on `git add`.
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  for (const [relativePath, content] of Object.entries(seedFiles)) {
    writeFile(relativePath, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: root });

  return {
    root,
    writeFile,
    readFile(relativePath: string): string {
      return readFileSync(join(root, relativePath), "utf8");
    },
    close(): void {
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
