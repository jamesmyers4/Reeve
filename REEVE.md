# REEVE.md — build plan for the Sonnet-supervised qwen task loop

**Provenance:** Grilled out of `ACER-LAPTOP.md` via a `/grill-with-docs` session on 2026-08-01, run inside the Drover repo (using the `grilling` skill) so the interrogation could draw on Drover's own `CONTEXT.md`/`CLAUDE.md`/`FUTUREPLAN.md`/`GAPS.md` as prior art. Every open question `ACER-LAPTOP.md` left unresolved is now decided below — this file is the thing to copy into Reeve's own new, standalone repo to actually start building from. `ACER-LAPTOP.md` is deleted once this file exists; nothing in it isn't already carried forward here.

**What Reeve is:** a name for this project (a reeve historically oversaw an estate's laborers — apt for "Sonnet supervises qwen"). It automates a pattern that was already validated manually across 13 real sessions: a cheap local model (qwen2.5:3b via Ollama) does atomic, mechanical code edits; Sonnet (via the metered Anthropic API, never claude.ai/Pro-plan chat) authors the atomic task breakdown and reviews qwen's output; a bounded retry loop escalates to a human rather than looping forever. It runs unattended on a headless Ubuntu Acer laptop registered as a GitHub Actions self-hosted runner, triggered manually via `workflow_dispatch`.

**Relationship to Drover:** Reeve is a **fully standalone sibling repo** — no code dependency on Drover at all (no submodule, no npm link, no shared `node_modules`). It reuses Drover's _conventions_ where they genuinely fit (a `ModelProvider`-shaped interface per model role, a budget-ceiling pattern, versioned SQLite migrations, session-by-session build discipline with manual commits) the same way Drover's own Grader subsystem copied conventions from its actor tier without importing actor-tier code. The reverse feedback loop matters too: **`DROVER.md`** (Session 6 below) is where real, evidence-backed lessons from actually building and running Reeve get written down specifically so a future Drover session building the Fixer tier can read them directly, instead of re-discovering the same things from scratch.

---

## How to use this document

Same discipline Drover's own `FUTUREPLAN.md`/`SESSION-10-PLAN.md` established, because it's proven to work across a long multi-session build:

- **Do not commit at the end of a session.** Leave changes staged/unstaged. Report what you built, then give the user a commit message to copy/paste — they review and commit by hand.
- **Do not proceed to the next numbered session in the same sitting**, even if it feels like a natural continuation. Stop, summarize (including any real dollar cost), and wait for the go-ahead.
- **Sessions are ordered by dependency.** Session 3's loop needs Session 2's providers; Session 4's git/PR code needs Session 3's loop output shape. Don't skip ahead.
- Read this whole file before starting any session, not just the section for the session you're on — several sessions reference decisions made in earlier ones.

---

## What's already decided (read once, don't re-litigate)

| Decision                  | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo placement            | Standalone sibling repo (**Reeve**), private, single-operator, zero code dependency on Drover                                                                                                                                                                                                                                                                                                                                                                    |
| Implementation stack      | TypeScript/Node, mirroring Drover's conventions (strict TS, ESM, `better-sqlite3`, `tsx`, `@anthropic-ai/sdk`) — no Playwright needed, qwen edits files, not a browser                                                                                                                                                                                                                                                                                           |
| Session boundary          | One GitHub Actions run = one whole task, single job, internal loop over every atomic step — not one run per step                                                                                                                                                                                                                                                                                                                                                 |
| Task input                | Free-text `workflow_dispatch` input, multi-line allowed (no forced one-liner), plus a `target_repo` choice input drawn from an allowlist that doubles as the PAT's scoped repo list, plus an optional `test_command` string                                                                                                                                                                                                                                      |
| Underspecified-task guard | Task-author Sonnet call may bail out immediately (`escalate: needs more detail`) before qwen is ever invoked — a distinct, cheaper first-call outcome from a normal post-attempt escalation                                                                                                                                                                                                                                                                      |
| Executor mechanism        | **Full-file rewrite via plain text completion** — harness sends qwen the current file content + one atomic instruction, qwen returns the complete new file content, harness writes it back verbatim. No tool-calling loop; a 3B model's tool-calling reliability is an unproven risk this design deliberately avoids                                                                                                                                             |
| Structural-check guard    | Cheap, best-effort check (non-empty, non-truncated, parses if a cheap checker exists for the language) runs on qwen's output _before_ it reaches Sonnet's review. A failure here **counts** as one of the step's attempts                                                                                                                                                                                                                                        |
| Acceptance gate           | Optional `test_command`. If set: baseline test run once per task (not per step, since steps are atomic by design); post-edit, any test that regresses from baseline forces an **unconditional** revise — Sonnet's review can't override a real regression. If unset: review is diff-only, Sonnet's judgment                                                                                                                                                      |
| Escalation cap            | **Fixed 3 attempts per step** (not a cumulative task-wide budget). Exceeding it escalates that step and aborts remaining steps in the task                                                                                                                                                                                                                                                                                                                       |
| Partial progress          | Steps that already passed **stay committed** to the branch when a later step escalates — no rollback. The escalation's PR/email description explains what's safe vs. what broke                                                                                                                                                                                                                                                                                  |
| Branch/PR convention      | `qwen-task/<short-task-id>-<slug>`, one PR per task. Full pass → PR ready for review. Step-escalation (real work happened) → same PR mechanism, opened **draft**, diagnostic description. Pre-flight escalation (task-author bailed, nothing executed) → no branch/PR at all, email only                                                                                                                                                                         |
| Prompt separation         | Two fully independent prompt templates — task-author and reviewer never share wording/framing. The reviewer only ever sees the atomic instruction + qwen's diff + test/structural result, never the task-author's rationale for the decomposition                                                                                                                                                                                                                |
| Model hardcoding          | `qwen2.5:3b` (Ollama) and `claude-sonnet-5` (Anthropic) hardcoded as named constants for v1 — no config surface for swapping models                                                                                                                                                                                                                                                                                                                              |
| Target repo               | Separate from Reeve's own repo — Reeve clones/checks out whatever `target_repo` is configured, edits there, pushes a branch, opens a PR against _that_ repo, using a cross-repo PAT                                                                                                                                                                                                                                                                              |
| PAT scope                 | One fine-grained PAT covering every target repo you point Reeve at (an explicit, editable repo allowlist — not "everything you own"), reused as both the credential's scope and the `target_repo` dropdown's valid choices, kept in sync deliberately                                                                                                                                                                                                            |
| Logging schema            | `reeve.sqlite` — **one single accumulating file**, not a fresh timestamped file per run (this exact mistake was already made and fixed once in Drover's own Grader Session 3 — see `DROVER.md`'s Session 6 entry). Scoped to audit/debugging only (task/step/attempt records with instruction, diff, test/structural result, verdict, reasoning, cost) — **not** pre-shaped for a hypothetical future cross-task analyst pass, since no such consumer exists yet |
| Budget guardrail          | Hard **per-task** dollar ceiling, checked before every Sonnet call (the task-author call, each review call) — escalates gracefully rather than mid-write if a call would exceed it                                                                                                                                                                                                                                                                               |
| treeLine                  | Not applicable — Reeve edits files/git, never drives a browser through a running app                                                                                                                                                                                                                                                                                                                                                                             |
| Notification              | Reuse the existing Resend email pattern (not a new channel). **Two distinct templates** — an escalation email (diagnostic: what passed/safe, what broke, why) and a final-pass email (handoff: here's the PR) — not one shared template with a status flag                                                                                                                                                                                                       |
| Trigger mode              | `workflow_dispatch` only for v1. No cron — there's no task queue/backlog for a scheduled run to pick up yet; add scheduling later as a config addition if a real queue mechanism gets built                                                                                                                                                                                                                                                                      |
| Repo visibility           | **Private**, single-operator collaborator list. This — not `workflow_dispatch`'s own default protections — is the actual guarantee that no fork-PR/external trigger surface can ever reach the self-hosted runner                                                                                                                                                                                                                                                |
| Escalation PR mechanism   | Reuses the exact same PR-object mechanism as the final-pass path (draft vs. ready-for-review), not a separate compare-link-email-only path — one mechanism, two states, two description templates                                                                                                                                                                                                                                                                |

---

## Non-negotiable constraints for v1 (do not re-decide these mid-build)

- **Never auto-merge, ever.** PR only (or draft PR on escalation) — a human always merges by hand.
- **Single-file atomic edits only.** No multi-file tasks until the single-file loop is proven reliable across real use.
- **Sequential only** — one task per run, one step at a time within it. No concurrent task execution.
- **Hard attempt ceiling, always** — 3 attempts per step, no exceptions, no separate "free retry" carve-out for structural-check failures (they count).
- **Hard per-task dollar ceiling**, checked before every Sonnet call, never mid-write.
- **No tool-calling for qwen** — full-file rewrite via plain text completion only.
- **Models hardcoded**, not configurable, for v1.
- **`reeve.sqlite` is one accumulating file**, never a fresh file per invocation.
- **Private repo, `workflow_dispatch`-only trigger, no cron** — no queue/backlog exists to schedule against yet.
- **No code dependency on Drover** — Reeve is a standalone repo; only _conventions_ carry over.
- **No cross-task analyst-style pattern mining in the schema** — log for audit/debugging only until a real need for it shows up.

---

## Architecture overview

```
src/
  types.ts           TaskRecord, TaskStep, Attempt, and the status/verdict enums
  db/
    migrations.ts     Versioned migration runner (mirrors Drover's DroverDb pattern)
    reeve-db.ts        ReeveDb — all reads/writes against reeve.sqlite
  providers/
    executor.ts        Executor interface + OllamaExecutor + ScriptedExecutor
    task-author.ts      TaskAuthor interface + AnthropicTaskAuthor + ScriptedTaskAuthor
    reviewer.ts         Reviewer interface + AnthropicReviewer + ScriptedReviewer
  prompts/
    task-author-prompt.ts   Independent from reviewer-prompt.ts — no shared builder
    reviewer-prompt.ts
  budget.ts            TaskBudget — per-task dollar ceiling, checked before every Sonnet call
  structural-check.ts  Cheap non-empty/non-truncated/best-effort-parse guard on qwen's output
  test-gate.ts         Baseline capture (once per task) + post-edit regression comparison
  loop.ts              runStep() (attempt loop, max 3) + runTask() (decompose -> steps -> outcome)
  git.ts               Branch creation, per-step commits, push via the cross-repo PAT
  pr.ts                gh pr create wrapper — ready-for-review vs. draft, per-outcome description
  notify.ts            Two Resend email templates (escalation vs. final-pass)
  cli.ts               The real entry point the GitHub Actions workflow calls
.github/workflows/
  reeve.yml            workflow_dispatch only, runs on the self-hosted runner label
tests/
  fixtures/repo.ts     A real throwaway local git repo, mirrors Drover's tests/fixtures/site.ts
```

---

## Session 0 — Acer machine bootstrap (manual — you, not a Claude Code session)

No code, no commit. A Claude Code session can't register a GitHub Actions runner or install Ollama on your behalf unless it's explicitly given terminal access to the Acer itself — treat this as your own checklist first.

1. Confirm the Acer is running headless Ubuntu Server, up to date.
2. Install Node 20+, `git`, and the `gh` CLI.
3. Install Ollama, `ollama pull qwen2.5:3b`, confirm `curl localhost:11434/api/tags` responds locally.
4. Create the new **private** `Reeve` GitHub repo — single-operator collaborator list (just you).
5. Register the Acer as a self-hosted runner for that repo (repo Settings → Actions → Runners → New self-hosted runner). Confirm it shows **Idle** in the repo's runner list.
6. Mint a fine-grained GitHub PAT scoped to exactly the target repo(s) you intend to point Reeve at initially (start small — you can widen the scope later), with `contents:write` + `pull-requests:write`. Store it as a repo secret (e.g. `REEVE_TARGET_PAT`).
7. Add repo secrets: `ANTHROPIC_API_KEY`, `REEVE_TARGET_PAT`, and your existing `RESEND_API_KEY`.
8. Confirm the repo's Actions settings restrict `workflow_dispatch` to people with write access (the default), and that there's no `pull_request`-triggered workflow anywhere in the repo that could route a fork PR onto this runner.

**Stop condition:** runner shows Idle, Ollama responds locally, all three secrets are set. Session 1 assumes all of this already exists — report status before it starts.

---

## Session 1 — Repo scaffold + core types + SQLite schema

**Cost: $0.** No LLM calls.

**Goal:** a real, migrated `reeve.sqlite` schema and the core TypeScript types — the storage foundation everything else writes to.

1. `package.json`/`tsconfig.json` (strict, ESM, Node ≥20), Biome config (remember to include `scripts/**` in `files.includes` from the start — Drover hit this as a real bug once, see `DROVER.md`), `vitest` for tests.
2. Core types: `TaskRecord` (id, description, targetRepo, status: `pending|running|passed|escalated|escalated-preflight`, branchName, prUrl?, createdAt), `TaskStep` (id, taskId, index, instruction, filePath, status: `pending|passed|escalated`), `Attempt` (id, stepId, attemptNumber, kind: `structural-check|test-gate|review`, fileContentBefore, fileContentAfter, structuralCheckResult?, testGateResult?, verdict: `pass|revise|escalate`, reasoning, costUsd, createdAt).
3. SQLite schema + versioned migration runner (mirror Drover's `migrate()` shape — a `schema_migrations` table, apply-in-order, skip-already-applied). Tables: `tasks`, `steps`, `attempts`. **One accumulating file, `reeve.sqlite`**, default path for the CLI — not a fresh timestamped file per invocation.
4. Tests: migrations apply cleanly from empty; round-trip a hand-built task/step/attempt through the schema; reopening an existing file is a true no-op re-migration (no duplicate DDL execution on a second `migrate()` call against the same file).

**Stop condition:** schema + types exist, migrate cleanly, tests pass. No providers, no CLI, no loop yet. Report what you built and any schema judgment calls made. Do not commit.

**Commit message to copy/paste:**

```
Reeve Session 1 — repo scaffold, core types, SQLite schema
```

---

## Session 2 — Model provider layer: Ollama executor + Anthropic task-author/reviewer

**Cost: $0 real spend** — every test uses scripted doubles; a real Ollama call is $0 regardless since it's local.

**Goal:** the three model-facing roles as clean, independently-testable interfaces, before anything wires them into a loop.

1. `Executor` interface (`rewrite(instruction, currentFileContent): Promise<{ newContent: string }>`) + `OllamaExecutor` (calls qwen2.5:3b's `/api/chat`, plain system+user prompt, **no tools array** — parses the returned content between explicit markers the prompt asks it to use) + `ScriptedExecutor`.
2. `TaskAuthor` interface + `AnthropicTaskAuthor` (forced structured tool-call output: either `{ steps: TaskStep[] }` or `{ escalate: true, reason: string }` for the pre-flight guard) + `ScriptedTaskAuthor`.
3. `Reviewer` interface + `AnthropicReviewer` (forced structured tool-call output: `{ verdict: "pass"|"revise"|"escalate", reasoning: string, revisedInstruction?: string }`) + `ScriptedReviewer`. Its prompt is written and templated **completely independently** from the task-author's.
4. The two independent prompt templates — each explicitly primed for its actual audience (task-author's prompt tells Sonnet it's writing for a 3B local executor; reviewer's prompt tells Sonnet it's judging that executor's output, not a peer's — the same "upfront persona-priming" principle the validated manual 13-session run relied on).
5. `TaskBudget` — mirrors Drover's `SessionBudget` shape: a running total, `assertCanCall()` checked before every Sonnet call (the task-author call, every review call), throwing/escalating once the per-task dollar ceiling would be exceeded.
6. Hardcode `OLLAMA_MODEL = "qwen2.5:3b"` and `SONNET_MODEL = "claude-sonnet-5"` as named constants — not config.
7. Tests: each provider's real-vs-scripted paths, malformed-output handling (mirror Drover's `MalformedDecisionError` precedent), budget ceiling enforcement (assert the provider is never actually called once the ceiling would be exceeded).

**Stop condition:** all three provider roles work in isolation against scripted doubles; budget ceiling proven. No orchestration loop, no git, no CLI yet. Do not commit.

**Commit message:**

```
Reeve Session 2 — Ollama executor + Anthropic task-author/reviewer providers, budget ceiling
```

---

## Session 3 — Core loop: structural check, baseline-diff test gate, step/task orchestration

**Cost: $0** — all tests run against scripted providers + a local throwaway git fixture repo.

**Goal:** prove the actual decompose → execute → gate → review → revise/pass/escalate loop end-to-end, entirely offline.

1. Structural-check guard: non-empty/non-truncated check + a best-effort per-language parse check (e.g. shell out to `tsc --noEmit`/`node --check` for JS/TS, `python -m py_compile` for Python; skip silently if no cheap checker is known for the file's extension). A failure here is recorded as a real attempt — **counts toward the 3-attempt ceiling** — and never reaches the reviewer.
2. Test gate: runs `test_command` (if provided) once at task start as the baseline, and again after each step's edit; diffs the two failure sets. Any test that passed at baseline and now fails forces `verdict: "revise"` **unconditionally**, bypassing the reviewer's own judgment for that signal entirely.
3. `runStep()`: attempt loop (max 3) calling executor → structural check → test-gate (if configured) → reviewer, in that order, short-circuiting to `revise`/`escalate` at whichever gate fails first. `runTask()`: task-author decompose (or pre-flight escalate, zero steps ever attempted) → iterate `runStep()` per step in order → the first step to escalate aborts remaining steps for that task, but everything already `passed` stays exactly as it landed (no rollback) → task ends `passed`/`escalated`/`escalated-preflight`.
4. Test fixture (`tests/fixtures/repo.ts`): a small helper creating a real throwaway local git repo (temp dir, `git init`, one seed file) — mirrors Drover's `tests/fixtures/site.ts` precedent of a real disposable target for integration tests rather than full mocking.
5. Tests: a clean multi-step task that fully passes; a task where one step needs one revision before passing; a task where a step exhausts its 3 attempts and escalates (assert earlier `passed` steps' file state is retained, not rolled back); a pre-flight escalation (task-author bails, zero executor calls made); a `test_command` regression forcing revise even when the scripted reviewer would otherwise have said pass.

**Stop condition:** a full task runs end-to-end against the fixture repo and `reeve.sqlite`, covering pass/revise/escalate/pre-flight-escalate — no git push or PR yet (that's Session 4). Report any loop edge cases hit. Do not commit.

**Commit message:**

```
Reeve Session 3 — core step/task loop: structural check, baseline test gate, revise/escalate
```

---

## Session 4 — Git/PR integration + notifications

**Cost: $0 for tests** (mocked `git`/`gh`/Resend calls) — real cost only starts in Session 5's live dry run.

**Goal:** turn a completed (or escalated) in-memory task result into a real branch, PR, and email.

1. Thin wrapper around shell `git`: create `qwen-task/<id>-<slug>` off the target repo's default branch, one commit per `passed` step (message = that step's instruction), push using the cross-repo PAT over HTTPS.
2. Wraps `gh pr create`: full pass → PR ready for review, description lists every step + its instruction + a final diff summary. Step-escalation (at least one step ran) → the same call with `--draft`, description explains which steps passed (marked safe) vs. which step escalated and why (its last attempt's reasoning + test/structural output verbatim). Pre-flight escalation → no git/PR call at all.
3. Two Resend email templates (escalation, final-pass), reusing whatever Resend client/from-address pattern your existing usage already established. The escalation template covers both step-escalation (links the draft PR) and pre-flight escalation (no PR link, just the task-author's stated reason). The final-pass template links the ready PR.
4. Tests: mock the `git`/`gh` child-process calls and the Resend client, asserting the right branch name, right draft-vs-ready state, right description content, and the right email template fires for each of the three end states (`passed`, `escalated`, `escalated-preflight`).

**Stop condition:** given a `runTask()` result object, the right combination of branch/PR/draft-state/email fires, proven via mocks — no real GitHub/Resend call made yet. Do not commit.

**Commit message:**

```
Reeve Session 4 — branch/PR creation and Resend escalation/final-pass notifications
```

---

## Session 5 — GitHub Actions workflow + real end-to-end dry run

**Cost: small, real** — a handful of genuine Sonnet calls (one task-author call + a few reviews) against a couple of trivial real tasks. Budget a few cents to roughly $1, with the per-task ceiling as the backstop, not the plan.

**Goal:** wire everything into the actual self-hosted-runner workflow and prove it end-to-end for real, against a disposable throwaway test repo — **not** the first real target you actually care about.

1. `.github/workflows/reeve.yml` — `workflow_dispatch` only, inputs: `task_description` (multiline string), `target_repo` (choice, matching the PAT's scoped allowlist from Session 0), `test_command` (string, optional/blank). Runs on the self-hosted runner label. Steps: checkout Reeve, install deps, run the CLI entry point with the dispatch inputs, writing to a `reeve.sqlite` path that actually persists between runs on the runner — **verify** where a self-hosted job can durably write on this specific runner setup rather than assuming a path; don't let it silently land inside the ephemeral per-job workspace if that gets wiped between runs.
2. `src/cli.ts` — the real entry point: reads the dispatch inputs, opens/migrates `reeve.sqlite`, runs the task via Session 3's `runTask()`, then calls Session 4's git/PR/notify code with the result.
3. Create one small, genuinely disposable private test repo specifically for this dry run — not one of your real projects — and give the Session 0 PAT write access to it.
4. Dispatch one deliberately trivial, unambiguous atomic task against it (e.g. "delete the unused `foo` variable on line 12 of `bar.ts`"), no `test_command` set. Confirm: qwen edits the file for real, Sonnet reviews for real, a real PR opens ready for review.
5. Dispatch one more with `test_command` set. Confirm the baseline/regression gate works against a real test run.
6. Dispatch one deliberately impossible task (e.g. instructing an edit to a file that doesn't exist). Confirm it escalates correctly — draft PR or pre-flight email, whichever end-state actually applies — rather than silently failing or hanging.

**Stop condition:** three real dispatches completed (plain pass, test-gated pass, forced escalation), each producing the correct branch/PR/email outcome. Report the actual dollar cost. This is the first real money spent on this project — do not point it at a repo you actually care about yet. Do not commit.

**Commit message:**

```
Reeve Session 5 — GitHub Actions workflow wiring, real end-to-end dry run against a throwaway repo
```

---

## Session 6 — DROVER.md write-up + real-task hardening pass

**Cost: staged, your call** — whatever real tasks you choose to run against an actual target repo, small and incremental, checking in after each one rather than batching them.

**Goal:** capture what actually got learned running this for real, in a form Drover's own eventual Fixer-tier session can consume directly — and close out anything Session 5's dry run left rough.

1. Write **`DROVER.md`** (Reeve's own repo root) — concrete, evidence-backed findings for whoever eventually builds Drover's Fixer tier. At minimum:
   - Whether full-file-rewrite-via-plain-text actually beat tool-calling for a 3B local model in practice, now that qwen has run for real a few times.
   - The single-accumulating-SQLite-file lesson — already learned once in Drover's own Grader Session 3 (see `FUTUREPLAN.md`'s Session 3 entry there), reconfirmed or given a new wrinkle here.
   - The pre-flight-escalation guard's actual value, if a real vague task ever triggered it.
   - The baseline-diff-not-Sonnet's-opinion test-gate pattern, and whether it held up against a real, messier test suite.
   - Reusing one PR-object mechanism (draft vs. ready) instead of two separate delivery paths for escalation vs. final-pass — did this actually simplify things in practice, or did draft-PR handling turn out to need its own special cases?
   - Anything real about qwen2.5:3b's actual instruction-following/output reliability worth knowing before Drover's own Fixer tier picks a local-model story.
2. Run a handful of genuinely varied real tasks (not just Session 5's three mechanical dry-run cases) against one real target repo you actually use — staged small, the same budget-tiering discipline Drover's own `SESSION-10-PLAN.md` used. Stop and report after each one rather than batching them all before checking in.
3. Start a `GAPS.md`-equivalent in Reeve's own repo (mirroring Drover's convention) and log any real rough edges hit — don't silently fix non-blocking issues mid-session without recording them first.
4. Update Reeve's own `README.md` with a real quickstart (bootstrap checklist reference, `workflow_dispatch` usage, what a dispatch actually looks like end to end) now that it's been proven to work for real.

**Stop condition:** `DROVER.md` exists with real, evidence-backed findings (not speculation); at least a few real varied tasks completed against a real target repo; Reeve's own gaps file started. Report the real findings plainly — this is the point where Reeve becomes genuinely useful day to day, not just a working demo. Do not commit.

**Commit message:**

```
Reeve Session 6 — DROVER.md backport notes, real-task hardening pass, gaps log
```

---

## Explicit non-goals for v1

Keep these off the table unless real usage surfaces a strong reason otherwise:

- No auto-merge to any branch, ever — PR (or draft PR) only, human merges by hand.
- No multi-file atomic tasks — single-file edits only until that's proven reliable.
- No persona simulation or browser driving — not applicable to this tool at all.
- No concurrent task execution — one task per run, sequential steps within it.
- No unbounded retry loops — 3 attempts per step, always, no exceptions.
- No cron/scheduled triggers — no queue/backlog mechanism exists yet to feed one.
- No model/config swapping surface — qwen2.5:3b and claude-sonnet-5 are hardcoded.
- No cross-task analyst-style pattern mining — `reeve.sqlite`'s schema is audit/debug-scoped only for v1.
- No GitHub-issue-based task intake — free-text `workflow_dispatch` input only.

---

## Reference material (original framing, preserved for context)

The following is preserved from `ACER-LAPTOP.md` because it's still useful background on _why_ this exists and what's already been validated — every ambiguity it originally left open is resolved in the sections above.

### The problem this solves

Claude Pro plan usage kept maxing out because a working pattern — Sonnet reviewing the output of a small local model doing mechanical code edits — was running manually. The loop: run qwen2.5:3b locally, copy its output into a Sonnet chat, read the assessment, copy corrections back to qwen, repeat. Real, validated pattern — just not automated, and burning Pro-plan quota on review calls that don't need to be interactive chat at all. The fix has two independent parts: move the Sonnet calls off claude.ai onto the metered Anthropic API, and automate the loop itself so qwen executes, Sonnet reviews, and revisions get kicked back down automatically.

### What was already validated (informed every decision above)

A 13-session manual run of this exact pattern succeeded end to end: Sonnet supervising qwen2.5:3b on real code tasks, broken into atomic steps ("remove X code, add X code"), with clear, explicit instructions. Two things specifically made it work and carry into the automated version unchanged:

- **Atomicity.** Tasks decomposed into single, mechanical, unambiguous edits — not "improve error handling," but "remove the try/catch on line 40, replace with an early return." A 3B model needs literal instructions, not judgment calls.
- **Upfront persona-priming.** When Sonnet writes instructions for qwen, it's told explicitly upfront who it's writing for — knowing the audience is a 3B local model changed how Sonnet phrased things. The same principle applies in reverse for the reviewer prompt.

### Target infrastructure

- **Acer laptop**, headless Ubuntu Server, registered as a GitHub Actions self-hosted runner.
- **Ollama** running locally, hosting qwen2.5:3b via its OpenAI-compatible/native endpoint.
- **Anthropic API** (metered key) for both the task-decomposition call and the review call.
- Triggered via `workflow_dispatch` only (see decisions above for why cron is deferred).
- The self-hosted runner must never be reachable by external/fork PRs — closed off structurally here by making the repo private with a single-operator collaborator list, not just relying on `workflow_dispatch`'s own default protections.
