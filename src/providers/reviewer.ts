/**
 * The reviewer role: Sonnet judges one attempt's before/after file content
 * against the atomic instruction the executor was given, plus whatever
 * structural-check/test-gate result already ran. Its prompt is written and
 * templated completely independently from the task-author's (see
 * reviewer-prompt.ts).
 */

import Anthropic from "@anthropic-ai/sdk";
import { computeCostUsd, SONNET_MODEL, type TokenUsage } from "../budget.js";
import { buildReviewerSystemPrompt, buildReviewerUserPrompt } from "../prompts/reviewer-prompt.js";
import type { StructuralCheckResult, TestGateResult, Verdict } from "../types.js";

export interface ReviewRequest {
  instruction: string;
  fileContentBefore: string;
  fileContentAfter: string;
  structuralCheckResult?: StructuralCheckResult;
  testGateResult?: TestGateResult;
}

export interface ReviewResult {
  verdict: Verdict;
  reasoning: string;
  revisedInstruction?: string;
}

export interface ReviewOutcome {
  result: ReviewResult;
  usage: TokenUsage & { costUsd: number };
}

export interface Reviewer {
  review(request: ReviewRequest): Promise<ReviewOutcome>;
}

export class MalformedReviewError extends Error {
  /** Mirrors Drover's MalformedDecisionError — set when the API call itself was billed, even if the tool-call payload failed to parse. */
  constructor(
    reason: string,
    readonly usage?: TokenUsage & { costUsd: number },
  ) {
    super(`Reviewer returned a malformed submit_review call: ${reason}`);
    this.name = "MalformedReviewError";
  }
}

const SUBMIT_REVIEW_TOOL: Anthropic.Tool = {
  name: "submit_review",
  description: "Record the verdict on one executor attempt: pass, revise, or escalate.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "revise", "escalate"],
        description:
          "'pass' if the after-content correctly and exclusively carries out the instruction. 'revise' if it needs another attempt with a clearer instruction. 'escalate' if this attempt should count toward giving up on the step entirely.",
      },
      reasoning: {
        type: "string",
        description: "Why you reached this verdict.",
      },
      revisedInstruction: {
        type: "string",
        description:
          "Required when verdict is 'revise' — a clearer, still-atomic instruction for the next attempt.",
      },
    },
    required: ["verdict", "reasoning"],
  },
};

class ReviewParseError extends Error {}

function parseReviewResult(input: unknown): ReviewResult {
  if (typeof input !== "object" || input === null) {
    throw new ReviewParseError("tool input was not an object");
  }
  const obj = input as Record<string, unknown>;
  if (obj.verdict !== "pass" && obj.verdict !== "revise" && obj.verdict !== "escalate") {
    throw new ReviewParseError(`invalid verdict "${String(obj.verdict)}"`);
  }
  if (typeof obj.reasoning !== "string" || !obj.reasoning.trim()) {
    throw new ReviewParseError("missing or empty 'reasoning'");
  }
  if (
    obj.verdict === "revise" &&
    (typeof obj.revisedInstruction !== "string" || !obj.revisedInstruction.trim())
  ) {
    throw new ReviewParseError("verdict is 'revise' but 'revisedInstruction' is missing or empty");
  }
  const result: ReviewResult = { verdict: obj.verdict, reasoning: obj.reasoning };
  if (typeof obj.revisedInstruction === "string")
    result.revisedInstruction = obj.revisedInstruction;
  return result;
}

export class AnthropicReviewer implements Reviewer {
  private readonly client: Anthropic;

  constructor(readonly model: string = SONNET_MODEL) {
    this.client = new Anthropic();
  }

  async review(request: ReviewRequest): Promise<ReviewOutcome> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: buildReviewerSystemPrompt(),
      messages: [{ role: "user", content: buildReviewerUserPrompt(request) }],
      tools: [SUBMIT_REVIEW_TOOL],
      tool_choice: { type: "tool", name: "submit_review" },
    });

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const billedUsage = { ...usage, costUsd: computeCostUsd(this.model, usage) };

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "submit_review",
    );
    if (!block) {
      throw new MalformedReviewError("no submit_review tool_use block in response", billedUsage);
    }
    let result: ReviewResult;
    try {
      result = parseReviewResult(block.input);
    } catch (err) {
      if (err instanceof ReviewParseError) {
        throw new MalformedReviewError(err.message, billedUsage);
      }
      throw err;
    }
    return { result, usage: billedUsage };
  }
}

/** Scripted/mocked reviewer for testing loop mechanics without a real Sonnet call. */
export class ScriptedReviewer implements Reviewer {
  private index = 0;

  constructor(
    private readonly script: ReviewResult[],
    private readonly costPerCallUsd = 0,
  ) {}

  async review(): Promise<ReviewOutcome> {
    const result = this.script[this.index];
    if (!result) {
      throw new Error(`ScriptedReviewer script exhausted after ${this.index} calls`);
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
