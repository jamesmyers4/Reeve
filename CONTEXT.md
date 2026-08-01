# Reeve — CONTEXT.md

## What this is

Reeve automates a pattern that was already validated manually across 13 real sessions: a cheap local model (`qwen2.5:3b` via Ollama) does atomic, mechanical code edits; Sonnet (via the metered Anthropic API, never claude.ai/Pro-plan chat) authors the atomic task breakdown and reviews qwen's output; a bounded retry loop escalates to a human rather than looping forever. It runs unattended on a headless Ubuntu Acer laptop registered as a GitHub Actions self-hosted runner, triggered manually via `workflow_dispatch`.

Name origin: a reeve historically oversaw an estate's laborers — apt for "Sonnet supervises qwen."

**The problem this solves:** Claude Pro plan usage kept maxing out because a working pattern — Sonnet reviewing the output of a small local model doing mechanical code edits — was running manually. The loop: run qwen2.5:3b locally, copy its output into a Sonnet chat, read the assessment, copy corrections back to qwen, repeat. Real, validated pattern — just not automated, and burning Pro-plan quota on review calls that don't need to be interactive chat at all. The fix has two independent parts: move the Sonnet calls off claude.ai onto the metered Anthropic API, and automate the loop itself so qwen executes, Sonnet reviews, and revisions get kicked back down automatically.

**What was already validated** (informed every decision below): a 13-session manual run of this exact pattern succeeded end to end: Sonnet supervising qwen2.5:3b on real code tasks, broken into atomic steps ("remove X code, add X code"), with clear, explicit instructions. Two things specifically made it work and carry into the automated version unchanged:

- **Atomicity.** Tasks decomposed into single, mechanical, unambiguous edits — not "improve error handling," but "remove the try/catch on line 40, replace with an early return." A 3B model needs literal instructions, not judgment calls.
- **Upfront persona-priming.** When Sonnet writes instructions for qwen, it's told explicitly upfront who it's writing for — knowing the audience is a 3B local model changed how Sonnet phrased things. The same principle applies in reverse for the reviewer prompt.

## Relationship to Drover

Reeve is a **fully standalone sibling repo** — no code dependency on Drover at all (no submodule, no npm link, no shared `node_modules`). It reuses Drover's _conventions_ where they genuinely fit (a `ModelProvider`-shaped interface per model role, a budget-ceiling pattern, versioned SQLite migrations, session-by-session build discipline with manual commits) the same way Drover's own Grader subsystem copied conventions from its actor tier without importing actor-tier code.

The reverse feedback loop matters too: **`DROVER.md`** (written in Session 6) is where real, evidence-backed lessons from actually building and running Reeve get written down specifically so a future Drover session building its Fixer tier can read them directly, instead of re-discovering the same things from scratch.

## Non-goals for v1

Keep these off the table unless real usage surfaces a strong reason otherwise:

- No auto-merge to any branch, ever — PR (or draft PR) only, human merges by hand.
- No multi-file atomic tasks — single-file edits only until that's proven reliable.
- No persona simulation or browser driving — not applicable to this tool at all.
- No concurrent task execution — one task per run, sequential steps within it.
- No unbounded retry loops — 3 attempts per step, always, no exceptions.
- No cron/scheduled triggers — no queue/backlog mechanism exists yet to feed one.
- No model/config swapping surface — `qwen2.5:3b` and `claude-sonnet-5` are hardcoded.
- No cross-task analyst-style pattern mining — `reeve.sqlite`'s schema is audit/debug-scoped only for v1.
- No GitHub-issue-based task intake — free-text `workflow_dispatch` input only.

## Target infrastructure

- **Acer laptop**, headless Ubuntu Server, registered as a GitHub Actions self-hosted runner.
- **Ollama** running locally, hosting `qwen2.5:3b` via its native endpoint.
- **Anthropic API** (metered key) for both the task-decomposition call and the review call.
- Triggered via `workflow_dispatch` only.
- The self-hosted runner must never be reachable by external/fork PRs — closed off structurally by making the repo private with a single-operator collaborator list, not just relying on `workflow_dispatch`'s own default protections.

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

`src/types.ts`, `src/db/`, `src/budget.ts`, `src/providers/`, `src/prompts/`, `src/structural-check.ts`, `src/test-gate.ts`, and `src/loop.ts` exist so far — see `CLAUDE.md` for current build status.

## Key decisions (do not re-litigate)

| Decision | Resolution |
| --- | --- |
| Repo placement | Standalone sibling repo (**Reeve**), private, single-operator, zero code dependency on Drover |
| Implementation stack | TypeScript/Node, mirroring Drover's conventions (strict TS, ESM, `better-sqlite3`, `tsx`, `@anthropic-ai/sdk`) — no Playwright needed, qwen edits files, not a browser |
| Session boundary | One GitHub Actions run = one whole task, single job, internal loop over every atomic step — not one run per step |
| Task input | Free-text `workflow_dispatch` input, multi-line allowed, plus a `target_repo` choice input drawn from an allowlist that doubles as the PAT's scoped repo list, plus an optional `test_command` string |
| Underspecified-task guard | Task-author Sonnet call may bail out immediately (`escalate: needs more detail`) before qwen is ever invoked — a distinct, cheaper first-call outcome from a normal post-attempt escalation |
| Executor mechanism | **Full-file rewrite via plain text completion** — harness sends qwen the current file content + one atomic instruction, qwen returns the complete new file content, harness writes it back verbatim. No tool-calling loop; a 3B model's tool-calling reliability is an unproven risk this design deliberately avoids |
| Structural-check guard | Cheap, best-effort check (non-empty, non-truncated, parses if a cheap checker exists for the language) runs on qwen's output _before_ it reaches Sonnet's review. A failure here **counts** as one of the step's attempts |
| Acceptance gate | Optional `test_command`. If set: baseline test run once per task; post-edit, any test that regresses from baseline forces an **unconditional** revise. If unset: review is diff-only, Sonnet's judgment |
| Escalation cap | **Fixed 3 attempts per step** (not a cumulative task-wide budget). Exceeding it escalates that step and aborts remaining steps in the task |
| Partial progress | Steps that already passed **stay committed** to the branch when a later step escalates — no rollback |
| Branch/PR convention | `qwen-task/<short-task-id>-<slug>`, one PR per task. Full pass → PR ready for review. Step-escalation → same PR mechanism, opened **draft**, diagnostic description. Pre-flight escalation → no branch/PR at all, email only |
| Prompt separation | Two fully independent prompt templates — task-author and reviewer never share wording/framing. The reviewer only ever sees the atomic instruction + qwen's diff + test/structural result, never the task-author's rationale |
| Model hardcoding | `qwen2.5:3b` (Ollama) and `claude-sonnet-5` (Anthropic) hardcoded as named constants for v1 — no config surface for swapping models |
| Target repo | Separate from Reeve's own repo — Reeve clones/checks out whatever `target_repo` is configured, edits there, pushes a branch, opens a PR against _that_ repo, using a cross-repo PAT |
| PAT scope | One fine-grained PAT covering every target repo Reeve is pointed at (an explicit, editable repo allowlist), reused as both the credential's scope and the `target_repo` dropdown's valid choices |
| Logging schema | `reeve.sqlite` — **one single accumulating file**, not a fresh timestamped file per run. Scoped to audit/debugging only — not pre-shaped for a hypothetical future cross-task analyst pass |
| Budget guardrail | Hard **per-task** dollar ceiling, checked before every Sonnet call, escalates gracefully rather than mid-write if a call would exceed it |
| Notification | Reuse the existing Resend email pattern. Two distinct templates — escalation (diagnostic) and final-pass (handoff) |
| Trigger mode | `workflow_dispatch` only for v1. No cron |
| Repo visibility | **Private**, single-operator collaborator list |
| Escalation PR mechanism | Reuses the exact same PR-object mechanism as the final-pass path (draft vs. ready-for-review), not a separate compare-link-email-only path |

## Non-negotiable constraints for v1

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

## Build discipline

Same discipline Drover's own `FUTUREPLAN.md`/`SESSION-10-PLAN.md` established:

- **Do not commit at the end of a session.** Changes are left staged/unstaged; the user reviews and commits by hand.
- **Do not proceed to the next numbered session in the same sitting**, even if it feels like a natural continuation. Stop, summarize (including any real dollar cost), and wait for the go-ahead.
- **Sessions are ordered by dependency** — see `CLAUDE.md`'s Build status / Remaining sessions for the full session-by-session plan (this is the durable copy; `REEVE.md`, the original grilling-session output this was ported from, is deleted once all sessions are done).
