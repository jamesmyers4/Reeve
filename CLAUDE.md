# CLAUDE.md — Reeve Technical Reference

Reeve is a Sonnet-supervised qwen task-execution loop: `qwen2.5:3b` (via Ollama) makes atomic, single-file code edits; Sonnet (metered Anthropic API) decomposes tasks into atomic steps and reviews qwen's output; a bounded retry loop escalates to a human rather than looping forever. The full product spec, decisions, and constraints are in **`CONTEXT.md`** in this repo root — read it in full at the start of every session before doing anything else. This file is the as-built technical map: what actually exists in the codebase, judgment calls made along the way, and what's left to build.

`REEVE.md` (the original session-by-session build plan this project was scaffolded from) still exists in the repo root right now but is scheduled for deletion once every session below is complete — everything durable from it has already been ported into `CONTEXT.md` and this file, so its removal loses nothing.

---

## Build status

**Session 1 — done** (2026-08-01): repo scaffold, core types, SQLite schema + migration runner. No LLM calls, $0 cost.

**Session 2 — done** (2026-08-01): the three model-facing provider roles (Ollama executor, Anthropic task-author, Anthropic reviewer), the two independent prompt templates, and the per-task budget ceiling. $0 real spend — every test uses scripted doubles or a mocked `@anthropic-ai/sdk`/`fetch`, no live Ollama or Anthropic call was made. See below for what exists and the judgment calls made.

**Not yet built:** everything from Session 3 onward — the core loop (structural check, baseline test gate, step/task orchestration), git/PR integration, the GitHub Actions workflow, and the real end-to-end dry run. See "Remaining sessions" below for the full plan.

**Session 0 (manual, not a Claude Code session):** the user is responsible for Acer machine bootstrap — headless Ubuntu, Node 20+, `git`/`gh` CLI, Ollama with `qwen2.5:3b` pulled, the private `Reeve` GitHub repo created, the Acer registered as a self-hosted Actions runner, a fine-grained PAT (`REEVE_TARGET_PAT`) scoped to target repos, and `ANTHROPIC_API_KEY`/`REEVE_TARGET_PAT`/`RESEND_API_KEY` stored as repo secrets. Session 1 assumes this is already done but does not depend on it (Session 1 has zero infra/network dependency).

---

## Architecture & module map (as built)

```
src/
  types.ts           TaskRecord, TaskStep, Attempt + status/kind/verdict unions,
                     StructuralCheckResult, TestGateResult
  budget.ts           SONNET_MODEL, PRICING, computeCostUsd, TaskBudget
  db/
    migrations.ts     Migration type + migrate() runner (schema_migrations table,
                       apply-in-order, skip-already-applied, one transaction per migration)
    reeve-db.ts        ReeveDb class — all reads/writes against reeve.sqlite, newId()
  providers/
    executor.ts        Executor interface + OllamaExecutor + ScriptedExecutor
    task-author.ts      TaskAuthor interface + AnthropicTaskAuthor + ScriptedTaskAuthor
    reviewer.ts         Reviewer interface + AnthropicReviewer + ScriptedReviewer
  prompts/
    task-author-prompt.ts   Independent from reviewer-prompt.ts — no shared builder
    reviewer-prompt.ts
tests/
  db.test.ts          Migration cleanliness, task/step/attempt round-trips, no-op
                       re-migration on reopen
  budget.test.ts       computeCostUsd pricing math, TaskBudget ceiling enforcement
  providers/
    executor.test.ts     OllamaExecutor real path (mocked fetch) + ScriptedExecutor
    task-author.test.ts  AnthropicTaskAuthor (mocked @anthropic-ai/sdk) + ScriptedTaskAuthor
    reviewer.test.ts     AnthropicReviewer (mocked @anthropic-ai/sdk) + ScriptedReviewer
```

Everything else in `CONTEXT.md`'s architecture diagram (`structural-check.ts`, `test-gate.ts`, `loop.ts`, `git.ts`, `pr.ts`, `notify.ts`, `cli.ts`, `.github/workflows/reeve.yml`) does not exist yet — built in Sessions 3–5.

### Types (`src/types.ts`)

- `TaskRecord` — `id`, `description`, `targetRepo`, `status` (`pending|running|passed|escalated|escalated-preflight`), optional `branchName`/`prUrl`, `createdAt`.
- `TaskStep` — `id`, `taskId`, `index`, `instruction`, `filePath`, `status` (`pending|passed|escalated`).
- `Attempt` — `id`, `stepId`, `attemptNumber`, `kind` (`structural-check|test-gate|review`), `fileContentBefore`/`fileContentAfter`, optional `structuralCheckResult`/`testGateResult`, `verdict` (`pass|revise|escalate`), `reasoning`, `costUsd`, `createdAt`.
- `StructuralCheckResult` (`{ passed, reason? }`) and `TestGateResult` (`{ passed, regressedTests[] }`) — **judgment call**: `REEVE.md`'s Session 1 spec left these two fields untyped ("structuralCheckResult?, testGateResult?"). Gave them small structured shapes now rather than leaving them as opaque strings/JSON, since Session 3's structural-check and test-gate guards will need to produce and consume something concrete — cheap to define now, and defining a shape doesn't lock in behavior that hasn't been built yet. Revisit in Session 3 if the real guards need different fields.

### Database (`src/db/`)

- `migrations.ts` exports `Migration` (`{ version, name, sql }`), the `migrations` array (currently one migration, `core-tables`, creating `tasks`/`steps`/`attempts`), and `migrate(db, migrationList)` — mirrors Drover's `SqliteStore`/`DroverDb` migration-runner shape (a `schema_migrations` table tracking applied versions, each migration run inside its own transaction, already-applied versions skipped). Kept as a plain exported function rather than a base class, since `REEVE.md`'s architecture section names only two db files (`migrations.ts`, `reeve-db.ts`) — Drover's three-file split (`sqlite-store.ts` + `migrations.ts` + `database.ts`) wasn't warranted for Reeve's single-consumer schema.
- `reeve-db.ts` exports `ReeveDb` (wraps `better-sqlite3`, runs `migrate()` in its constructor, `journal_mode = WAL` + `foreign_keys = ON`) and `newId()` (`randomUUID()`). Methods: `insertTask`/`getTask`/`updateTaskStatus`/`updateTaskBranch`/`updateTaskPrUrl`, `insertStep`/`getStep`/`listStepsForTask`/`updateStepStatus`, `insertAttempt`/`listAttemptsForStep`. Row↔domain-type mapping follows Drover's `database.ts` pattern: snake_case columns, JSON-serialized optional structured fields (`structural_check_result_json`, `test_gate_result_json`), optional TS fields built via conditional spread (`...(x !== null && { field: x })`) so `exactOptionalPropertyTypes` stays satisfied and round-trips are exact (`toEqual`, not just field-by-field).

### Schema (SQLite, one migration so far)

- `tasks(id, description, target_repo, status, branch_name, pr_url, created_at)` — `status` CHECK-constrained to the five `TaskStatus` values.
- `steps(id, task_id REFERENCES tasks, step_index, instruction, file_path, status)` — `index` renamed to `step_index` in SQL (reserved-adjacent word); `idx_steps_task` index on `(task_id, step_index)` for ordered per-task lookups.
- `attempts(id, step_id REFERENCES steps, attempt_number, kind, file_content_before, file_content_after, structural_check_result_json, test_gate_result_json, verdict, reasoning, cost_usd, created_at)` — `idx_attempts_step` index on `(step_id, attempt_number)`.
- `schema_migrations(version PRIMARY KEY, name, applied_at)` — created by `migrate()` itself, not a numbered migration.

**Judgment call:** `reeve.sqlite`'s default path isn't decided yet — no `cli.ts` exists to have a default path. `ReeveDb`'s constructor just takes whatever path it's given (or `:memory:` for tests). Session 5 explicitly calls out verifying where a self-hosted runner can durably write between jobs before picking a real default path — deferring that choice to Session 5 rather than guessing now is intentional, not an oversight.

### Budget (`src/budget.ts`)

`SONNET_MODEL = "claude-sonnet-5"` (hardcoded per `CONTEXT.md`'s model-hardcoding decision — Reeve's own spec already names this exact model, so it's honored as-is rather than substituted). `PRICING` mirrors Drover's `src/actor/budget.ts` shape (`inputPerM`/`outputPerM`, `computeCostUsd` applying a 1.25× cache-write / 0.1× cache-read multiplier) — same list price Drover records for `claude-sonnet-5` ($3/$15 per M tokens), not the temporary 2026-08-31 introductory rate, since a hardcoded intro price would silently go stale once the promotion ends. `TaskBudget` differs from Drover's `SessionBudget` on purpose: Drover's is a soft per-persona-session cap checked after the fact (`exceeded` getter); Reeve's `assertCanCall()` is a hard pre-flight gate that throws `TaskBudgetExceededError` before a call that would cross the ceiling is ever made, per `CONTEXT.md`'s "checked before every Sonnet call, never mid-write."

### Providers (`src/providers/`, `src/prompts/`)

- **`executor.ts`** — `Executor.rewrite(instruction, currentFileContent)`. `OllamaExecutor` posts a plain `system`+`user` chat to `qwen2.5:3b` via Ollama's `/api/chat`, **no `tools` array** — the prompt asks qwen to return the complete new file content between literal `<<<REEVE_FILE_START>>>`/`<<<REEVE_FILE_END>>>` markers, and `parseRewrite()` extracts what's between them, throwing `MalformedRewriteError` if the markers are missing, out of order, or the extracted content is empty. `ScriptedExecutor` returns each entry of a string array in order, for loop tests in Session 3+.
- **`task-author.ts`** — `TaskAuthor.decompose(taskDescription, targetRepo)`. `AnthropicTaskAuthor` forces a single `author_task` tool call (`tool_choice: {type: "tool", name: "author_task"}`) returning either `{escalate: false, steps: TaskStepDraft[]}` or `{escalate: true, reason}` — the pre-flight escalation path from `CONTEXT.md`. Cost is computed from `response.usage` **unconditionally, before parsing** the tool call, mirroring Drover's `MalformedDecisionError` precedent exactly: a malformed `author_task` payload still reports the billed usage on `MalformedTaskAuthorError.usage`, since the API call itself was charged regardless of whether the payload parsed.
- **`reviewer.ts`** — `Reviewer.review(request)`, forcing a `submit_review` tool call returning `{verdict, reasoning, revisedInstruction?}` (`revisedInstruction` required only when `verdict === "revise"`). Same billed-usage-on-malformed-output pattern as the task-author (`MalformedReviewError`).
- **`prompts/task-author-prompt.ts`** and **`prompts/reviewer-prompt.ts`** — two separate modules with no shared builder function, per `CONTEXT.md`'s prompt-separation decision. Each opens by telling Sonnet explicitly who it's writing for/judging (a 3B local executor with no judgment of its own) — the "upfront persona-priming" principle the validated 13-session manual run relied on. The reviewer prompt is built only from `{instruction, fileContentBefore, fileContentAfter, structuralCheckResult?, testGateResult?}` — it never receives the task-author's decomposition rationale.

**Judgment call:** the reviewer prompt shows the executor's full before/after file content, labeled, rather than a computed unified diff — `CONTEXT.md` says the reviewer sees "the atomic instruction + qwen's diff," but Session 2 is provider-interfaces-only and a real diff (via `git diff` against an actual repo) doesn't exist until there's a real git working tree to diff, which is Session 3/4 territory. Full before/after content is a reasonable Session 2 stand-in — Sonnet can compare two blocks of text itself — and avoids pulling in a diff library or git dependency prematurely. Revisit once `git.ts` (Session 4) or the structural-check/test-gate modules (Session 3) give the loop something real to diff.

**Judgment call:** `AnthropicTaskAuthor`/`AnthropicReviewer` construct their own `Anthropic()` client per instance (matching Drover's `AnthropicModelProvider` pattern) rather than accepting an injected client — tests mock the whole `@anthropic-ai/sdk` module (same technique as Drover's `tests/actor/provider.test.ts`: `messages` is an instance property set in the constructor, not a prototype getter, so it can't be spied on after construction).

---

## Tooling (as built)

- **TypeScript**: strict, ESM (`NodeNext`), `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes` — mirrors Drover's `tsconfig.json` exactly. `tsconfig.typecheck.json` extends it with `noEmit` + includes `tests`/`scripts` for `npm run typecheck`.
- **Biome**: `files.includes` covers `src/**`, `tests/**`, `scripts/**` from the very start — Drover hit a real bug once from forgetting `scripts/**` (see this file's history once `DROVER.md` exists), so it's included here even though `scripts/` doesn't exist yet.
- **vitest**: `npm test` runs `vitest run`. No `vitest.config.ts` — defaults are sufficient, same as Drover.
- **better-sqlite3**, **@anthropic-ai/sdk**: the two runtime dependencies so far. Everything else in `CONTEXT.md`'s stack list (`commander`, `dotenv`, etc.) is deliberately not installed yet — added when a later session actually needs it, not preemptively.

Verified clean as of Session 2: `npm run typecheck`, `npm test` (42/42 passing), `npm run lint` (0 warnings).

---

## Non-negotiable constraints (from `CONTEXT.md` — do not re-decide these)

- Never auto-merge, ever — PR (or draft PR) only, human merges by hand.
- Single-file atomic edits only — no multi-file tasks.
- Sequential only — one task per run, one step at a time.
- Hard 3-attempt ceiling per step, always, no exceptions.
- Hard per-task dollar ceiling, checked before every Sonnet call, never mid-write.
- No tool-calling for qwen — full-file rewrite via plain text completion only.
- Models hardcoded (`qwen2.5:3b`, `claude-sonnet-5`), not configurable, for v1.
- `reeve.sqlite` is one accumulating file, never a fresh file per invocation.
- Private repo, `workflow_dispatch`-only trigger, no cron.
- No code dependency on Drover — conventions only.
- No cross-task analyst-style pattern mining in the schema for v1.

---

## Remaining sessions

Ported verbatim from `REEVE.md` so this plan survives that file's deletion. Read `CONTEXT.md` in full before starting any of these — several reference decisions made earlier. Do not commit at the end of a session (report a commit message for the user to run by hand) and do not start the next session in the same sitting.

Session 2 (model provider layer) is done — see "Build status" and the "Providers" / "Budget" sections above for what actually got built and the judgment calls made.

### Session 3 — Core loop: structural check, baseline-diff test gate, step/task orchestration

**Cost: $0** — all tests run against scripted providers + a local throwaway git fixture repo.

1. Structural-check guard: non-empty/non-truncated + best-effort per-language parse check (shell out to `tsc --noEmit`/`node --check`/`python -m py_compile`; skip silently if no cheap checker is known). A failure here **counts** toward the 3-attempt ceiling and never reaches the reviewer.
2. Test gate: runs `test_command` (if provided) once at task start as baseline, again after each step's edit; diffs failure sets. Any newly-failing test forces `verdict: "revise"` **unconditionally**, bypassing the reviewer for that signal.
3. `runStep()`: attempt loop (max 3) calling executor → structural check → test-gate (if configured) → reviewer, short-circuiting to `revise`/`escalate` at whichever gate fails first. `runTask()`: task-author decompose (or pre-flight escalate) → iterate `runStep()` per step → first escalation aborts remaining steps, already-`passed` steps stay as landed (no rollback) → task ends `passed`/`escalated`/`escalated-preflight`.
4. `tests/fixtures/repo.ts` — a real throwaway local git repo (temp dir, `git init`, one seed file), mirrors Drover's `tests/fixtures/site.ts`.
5. Tests: full multi-step pass; one revision before passing; a step that exhausts 3 attempts and escalates (earlier `passed` steps retained); pre-flight escalation (zero executor calls); a `test_command` regression forcing revise even when the scripted reviewer would say pass.

**Stop condition:** a full task runs end-to-end against the fixture repo and `reeve.sqlite`, covering pass/revise/escalate/pre-flight-escalate — no git push or PR yet.

**Commit message:** `Reeve Session 3 — core step/task loop: structural check, baseline test gate, revise/escalate`

### Session 4 — Git/PR integration + notifications

**Cost: $0 for tests** (mocked `git`/`gh`/Resend calls).

1. Thin wrapper around shell `git`: create `qwen-task/<id>-<slug>` off the target repo's default branch, one commit per `passed` step (message = that step's instruction), push using the cross-repo PAT over HTTPS.
2. Wraps `gh pr create`: full pass → PR ready for review, description lists every step + instruction + final diff summary. Step-escalation → same call with `--draft`, description explains passed-vs-escalated steps with the last attempt's reasoning + test/structural output verbatim. Pre-flight escalation → no git/PR call at all.
3. Two Resend email templates (escalation, final-pass) reusing the existing Resend client/from-address pattern. Escalation template covers both step-escalation (links draft PR) and pre-flight escalation (no PR link, just the task-author's stated reason). Final-pass template links the ready PR.
4. Tests: mock `git`/`gh` child-process calls and the Resend client; assert branch name, draft-vs-ready state, description content, and correct email template per end state.

**Stop condition:** given a `runTask()` result, the right branch/PR/draft-state/email fires, proven via mocks — no real GitHub/Resend call yet.

**Commit message:** `Reeve Session 4 — branch/PR creation and Resend escalation/final-pass notifications`

### Session 5 — GitHub Actions workflow + real end-to-end dry run

**Cost: small, real** — a handful of genuine Sonnet calls. Budget a few cents to roughly $1, per-task ceiling as backstop.

1. `.github/workflows/reeve.yml` — `workflow_dispatch` only, inputs: `task_description` (multiline), `target_repo` (choice, matching PAT's scoped allowlist), `test_command` (optional). Runs on the self-hosted runner label. **Verify** where a self-hosted job can durably write `reeve.sqlite` between runs on this specific runner — don't assume a path that gets wiped between jobs.
2. `src/cli.ts` — real entry point: reads dispatch inputs, opens/migrates `reeve.sqlite`, runs the task via Session 3's `runTask()`, calls Session 4's git/PR/notify code with the result.
3. One small, genuinely disposable private test repo for this dry run — not a real project — with the Session 0 PAT given write access.
4. Dispatch one trivial, unambiguous task (e.g. "delete the unused `foo` variable on line 12 of `bar.ts`"), no `test_command`. Confirm real edit, real review, real PR ready for review.
5. Dispatch one more with `test_command` set — confirm baseline/regression gate works for real.
6. Dispatch one deliberately impossible task (e.g. edit a nonexistent file) — confirm it escalates correctly (draft PR or pre-flight email) rather than failing silently or hanging.

**Stop condition:** three real dispatches completed (plain pass, test-gated pass, forced escalation), correct outcome each time. Report the actual dollar cost — this is the first real money this project spends; don't point it at a repo that actually matters yet.

**Commit message:** `Reeve Session 5 — GitHub Actions workflow wiring, real end-to-end dry run against a throwaway repo`

### Session 6 — DROVER.md write-up + real-task hardening pass

**Cost: staged, user's call** — small, incremental real tasks, checking in after each rather than batching.

1. Write **`DROVER.md`** (Reeve's own repo root) — concrete, evidence-backed findings for whoever eventually builds Drover's Fixer tier. At minimum: whether full-file-rewrite beat tool-calling for a 3B model in practice; the single-accumulating-SQLite-file lesson reconfirmed (or a new wrinkle); the pre-flight-escalation guard's actual value if a real vague task triggered it; whether the baseline-diff test-gate pattern held up against a real, messier test suite; whether reusing one PR-object mechanism (draft vs. ready) actually simplified things; anything real about qwen2.5:3b's instruction-following reliability.
2. Run a handful of genuinely varied real tasks against one real target repo, staged small, stopping to report after each.
3. Start a `GAPS.md` in Reeve's own repo, logging real rough edges as they're hit rather than silently fixing them mid-session.
4. Update `README.md` with a real quickstart now that it's proven to work for real.

**Stop condition:** `DROVER.md` exists with real findings; a few real varied tasks completed against a real target repo; `GAPS.md` started.

**Commit message:** `Reeve Session 6 — DROVER.md backport notes, real-task hardening pass, gaps log`
