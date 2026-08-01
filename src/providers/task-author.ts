/**
 * The task-author role: Sonnet decomposes a free-text task description into
 * an ordered sequence of atomic, single-file edit steps for the executor —
 * or bails out with a pre-flight escalation before qwen is ever invoked, if
 * the task is too underspecified to decompose unambiguously.
 *
 * Structured output only: every decision comes back through a forced
 * `author_task` tool call, never free-text parsing — same discipline as
 * Drover's actor-tier `decide_action` (CLAUDE.md Session 3 there).
 */

import Anthropic from "@anthropic-ai/sdk";
import { computeCostUsd, SONNET_MODEL, type TokenUsage } from "../budget.js";
import {
  buildTaskAuthorSystemPrompt,
  buildTaskAuthorUserPrompt,
} from "../prompts/task-author-prompt.js";

export interface TaskStepDraft {
  instruction: string;
  filePath: string;
}

export type TaskAuthorResult =
  | { escalate: false; steps: TaskStepDraft[] }
  | { escalate: true; reason: string };

export interface TaskAuthorDecomposeResult {
  result: TaskAuthorResult;
  usage: TokenUsage & { costUsd: number };
}

export interface TaskAuthor {
  decompose(taskDescription: string, targetRepo: string): Promise<TaskAuthorDecomposeResult>;
}

export class MalformedTaskAuthorError extends Error {
  /** Mirrors Drover's MalformedDecisionError — set when the API call itself was billed, even if the tool-call payload failed to parse. */
  constructor(
    reason: string,
    readonly usage?: TokenUsage & { costUsd: number },
  ) {
    super(`Task-author returned a malformed author_task call: ${reason}`);
    this.name = "MalformedTaskAuthorError";
  }
}

const AUTHOR_TASK_TOOL: Anthropic.Tool = {
  name: "author_task",
  description:
    "Record either the ordered atomic edit steps for this task, or a pre-flight escalation if the task can't be decomposed unambiguously.",
  input_schema: {
    type: "object",
    properties: {
      escalate: {
        type: "boolean",
        description: "True to escalate before any step is attempted, instead of producing steps.",
      },
      reason: {
        type: "string",
        description:
          "Required when escalate is true — why the task can't be decomposed unambiguously.",
      },
      steps: {
        type: "array",
        description: "Required when escalate is false — the ordered atomic edit steps.",
        items: {
          type: "object",
          properties: {
            instruction: {
              type: "string",
              description: "One literal, mechanical instruction for a single-file edit.",
            },
            filePath: {
              type: "string",
              description:
                "Path (relative to the target repo root) of the one file this step edits.",
            },
          },
          required: ["instruction", "filePath"],
        },
      },
    },
    required: ["escalate"],
  },
};

class TaskAuthorParseError extends Error {}

function parseTaskAuthorResult(input: unknown): TaskAuthorResult {
  if (typeof input !== "object" || input === null) {
    throw new TaskAuthorParseError("tool input was not an object");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.escalate !== "boolean") {
    throw new TaskAuthorParseError("missing or non-boolean 'escalate'");
  }
  if (obj.escalate) {
    if (typeof obj.reason !== "string" || !obj.reason.trim()) {
      throw new TaskAuthorParseError("escalate is true but 'reason' is missing or empty");
    }
    return { escalate: true, reason: obj.reason };
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new TaskAuthorParseError("escalate is false but 'steps' is missing or empty");
  }
  const steps: TaskStepDraft[] = obj.steps.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new TaskAuthorParseError(`steps[${i}] was not an object`);
    }
    const step = raw as Record<string, unknown>;
    if (typeof step.instruction !== "string" || !step.instruction.trim()) {
      throw new TaskAuthorParseError(`steps[${i}] missing or empty 'instruction'`);
    }
    if (typeof step.filePath !== "string" || !step.filePath.trim()) {
      throw new TaskAuthorParseError(`steps[${i}] missing or empty 'filePath'`);
    }
    return { instruction: step.instruction, filePath: step.filePath };
  });
  return { escalate: false, steps };
}

export class AnthropicTaskAuthor implements TaskAuthor {
  private readonly client: Anthropic;

  constructor(readonly model: string = SONNET_MODEL) {
    this.client = new Anthropic();
  }

  async decompose(taskDescription: string, targetRepo: string): Promise<TaskAuthorDecomposeResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: buildTaskAuthorSystemPrompt(),
      messages: [
        { role: "user", content: buildTaskAuthorUserPrompt({ taskDescription, targetRepo }) },
      ],
      tools: [AUTHOR_TASK_TOOL],
      tool_choice: { type: "tool", name: "author_task" },
    });

    // Computed unconditionally — the API call is billed as soon as `response`
    // comes back, regardless of whether the tool call inside it is well-formed.
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const billedUsage = { ...usage, costUsd: computeCostUsd(this.model, usage) };

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "author_task",
    );
    if (!block) {
      throw new MalformedTaskAuthorError("no author_task tool_use block in response", billedUsage);
    }
    let result: TaskAuthorResult;
    try {
      result = parseTaskAuthorResult(block.input);
    } catch (err) {
      if (err instanceof TaskAuthorParseError) {
        throw new MalformedTaskAuthorError(err.message, billedUsage);
      }
      throw err;
    }
    return { result, usage: billedUsage };
  }
}

/** Scripted/mocked task-author for testing loop mechanics without a real Sonnet call. */
export class ScriptedTaskAuthor implements TaskAuthor {
  private index = 0;

  constructor(
    private readonly script: TaskAuthorResult[],
    private readonly costPerCallUsd = 0,
  ) {}

  async decompose(): Promise<TaskAuthorDecomposeResult> {
    const result = this.script[this.index];
    if (!result) {
      throw new Error(`ScriptedTaskAuthor script exhausted after ${this.index} calls`);
    }
    this.index++;
    return {
      result,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costUsd: this.costPerCallUsd,
      },
    };
  }
}
