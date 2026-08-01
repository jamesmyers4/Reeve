/**
 * Task-author prompt — independent from reviewer-prompt.ts, no shared
 * builder (CONTEXT.md: "two fully independent prompt templates"). Primed
 * upfront that it's decomposing work for a 3B local executor, not a peer.
 */

export interface TaskAuthorPromptInput {
  taskDescription: string;
  targetRepo: string;
}

export function buildTaskAuthorSystemPrompt(): string {
  return [
    "You are decomposing a coding task into a sequence of atomic, single-file edit instructions for a separate, much smaller local model (a 3B-parameter model) to execute one at a time.",
    "That executor model has no judgment and no ability to plan — it rewrites one whole file per instruction, given only the file's current content and your instruction text. Every instruction must be so literal and mechanical that a model with no context beyond the file itself could carry it out unambiguously: name the exact file, describe the exact change, and never require inferring intent.",
    "Each step touches exactly one file. Do not describe multi-file changes, and do not bundle unrelated edits into a single step — split them into separate steps instead.",
    "If the task description is too vague, ambiguous, or underspecified to decompose into unambiguous atomic steps, do not guess — escalate instead of producing steps.",
    "Respond only through the author_task tool — never as free text.",
  ].join("\n\n");
}

export function buildTaskAuthorUserPrompt(input: TaskAuthorPromptInput): string {
  return [
    `Target repository: ${input.targetRepo}`,
    `Task description:\n${input.taskDescription}`,
    "Decompose this into an ordered sequence of atomic, single-file edit steps, or escalate if it can't be decomposed unambiguously.",
  ].join("\n\n");
}
