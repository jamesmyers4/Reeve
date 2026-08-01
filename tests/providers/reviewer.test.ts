import { describe, expect, it, vi } from "vitest";
import { SONNET_MODEL } from "../../src/budget.js";

// Same module-mocking approach as tests/providers/task-author.test.ts —
// `messages` is an instance property, so the whole SDK module is mocked.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function MockAnthropic(this: { messages: unknown }) {
    this.messages = { create: mockCreate };
  }),
}));

const { AnthropicReviewer, MalformedReviewError, ScriptedReviewer } = await import(
  "../../src/providers/reviewer.js"
);

const BASE_USAGE = {
  input_tokens: 800,
  output_tokens: 150,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const BASE_REQUEST = {
  instruction: "Remove the unused foo variable.",
  fileContentBefore: "const foo = 1;\nexport function bar() {}\n",
  fileContentAfter: "export function bar() {}\n",
};

describe("AnthropicReviewer", () => {
  it("hardcodes claude-sonnet-5 by default", () => {
    const reviewer = new AnthropicReviewer();
    expect(reviewer.model).toBe(SONNET_MODEL);
  });

  it("parses a pass verdict and reports billed cost", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_review",
          input: {
            verdict: "pass",
            reasoning: "Removed exactly the unused variable, nothing else changed.",
          },
        },
      ],
      usage: BASE_USAGE,
    });
    const reviewer = new AnthropicReviewer();

    const { result, usage } = await reviewer.review(BASE_REQUEST);

    expect(result.verdict).toBe("pass");
    expect(result.revisedInstruction).toBeUndefined();
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it("parses a revise verdict with a revised instruction", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_review",
          input: {
            verdict: "revise",
            reasoning: "It also renamed bar to baz, which wasn't asked for.",
            revisedInstruction:
              "Remove only the unused foo variable; leave everything else unchanged.",
          },
        },
      ],
      usage: BASE_USAGE,
    });
    const reviewer = new AnthropicReviewer();

    const { result } = await reviewer.review(BASE_REQUEST);

    expect(result.verdict).toBe("revise");
    expect(result.revisedInstruction).toMatch(/leave everything else unchanged/);
  });

  it("passes an unconditional test-gate failure through into the prompt without overriding it locally", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_review",
          input: {
            verdict: "revise",
            reasoning: "Test gate regressed.",
            revisedInstruction: "try again",
          },
        },
      ],
      usage: BASE_USAGE,
    });
    const reviewer = new AnthropicReviewer();

    await reviewer.review({
      ...BASE_REQUEST,
      testGateResult: { passed: false, regressedTests: ["bar.test.ts > removes foo"] },
    });

    const call = mockCreate.mock.calls.at(-1)?.[0] as { messages: Array<{ content: string }> };
    expect(call.messages[0]?.content).toMatch(/Regressed tests: bar\.test\.ts > removes foo/);
  });

  it("throws MalformedReviewError with billed usage when no tool_use block comes back", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Looks fine to me." }],
      usage: BASE_USAGE,
    });
    const reviewer = new AnthropicReviewer();

    const err = await reviewer.review(BASE_REQUEST).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedReviewError);
    const malformed = err as InstanceType<typeof MalformedReviewError>;
    expect(malformed.usage?.costUsd).toBeGreaterThan(0);
  });

  it("throws MalformedReviewError when verdict is 'revise' but revisedInstruction is missing", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_review",
          input: { verdict: "revise", reasoning: "needs work" },
        },
      ],
      usage: BASE_USAGE,
    });
    const reviewer = new AnthropicReviewer();

    const err = await reviewer.review(BASE_REQUEST).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedReviewError);
    expect((err as Error).message).toMatch(/revisedInstruction/);
  });

  it("throws MalformedReviewError for an invalid verdict value", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_review",
          input: { verdict: "maybe", reasoning: "unsure" },
        },
      ],
      usage: BASE_USAGE,
    });
    const reviewer = new AnthropicReviewer();

    await expect(reviewer.review(BASE_REQUEST)).rejects.toThrow(MalformedReviewError);
  });
});

describe("ScriptedReviewer", () => {
  it("returns each scripted result in order, at zero cost by default", async () => {
    const reviewer = new ScriptedReviewer([
      { verdict: "pass", reasoning: "looks right" },
      { verdict: "escalate", reasoning: "exhausted attempts" },
    ]);

    const first = await reviewer.review(BASE_REQUEST);
    expect(first.result.verdict).toBe("pass");
    expect(first.usage.costUsd).toBe(0);

    const second = await reviewer.review(BASE_REQUEST);
    expect(second.result.verdict).toBe("escalate");
  });

  it("throws once the script is exhausted", async () => {
    const reviewer = new ScriptedReviewer([{ verdict: "pass", reasoning: "ok" }]);
    await reviewer.review(BASE_REQUEST);

    await expect(reviewer.review(BASE_REQUEST)).rejects.toThrow(/script exhausted/);
  });
});
