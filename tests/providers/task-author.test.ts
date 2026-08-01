import { describe, expect, it, vi } from "vitest";
import { SONNET_MODEL } from "../../src/budget.js";

// The real SDK's `messages` is an instance property set in the constructor,
// not a prototype getter, so it can't be spied on after construction — mock
// the whole module instead. This also means these tests never need a real
// ANTHROPIC_API_KEY (Session 2's cost is $0 — no real Sonnet calls).
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function MockAnthropic(this: { messages: unknown }) {
    this.messages = { create: mockCreate };
  }),
}));

const { AnthropicTaskAuthor, MalformedTaskAuthorError, ScriptedTaskAuthor } = await import(
  "../../src/providers/task-author.js"
);

const BASE_USAGE = {
  input_tokens: 500,
  output_tokens: 100,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

describe("AnthropicTaskAuthor", () => {
  it("hardcodes claude-sonnet-5 by default", () => {
    const author = new AnthropicTaskAuthor();
    expect(author.model).toBe(SONNET_MODEL);
  });

  it("parses a well-formed decompose result and reports billed cost", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "author_task",
          input: {
            escalate: false,
            steps: [{ instruction: "Delete the unused foo variable.", filePath: "src/bar.ts" }],
          },
        },
      ],
      usage: BASE_USAGE,
    });
    const author = new AnthropicTaskAuthor();

    const { result, usage } = await author.decompose("remove dead code", "org/repo");

    expect(result).toEqual({
      escalate: false,
      steps: [{ instruction: "Delete the unused foo variable.", filePath: "src/bar.ts" }],
    });
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it("parses a pre-flight escalation", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "author_task",
          input: { escalate: true, reason: "The task doesn't say which file to edit." },
        },
      ],
      usage: BASE_USAGE,
    });
    const author = new AnthropicTaskAuthor();

    const { result } = await author.decompose("make it better", "org/repo");

    expect(result).toEqual({ escalate: true, reason: "The task doesn't say which file to edit." });
  });

  it("throws MalformedTaskAuthorError with billed usage when no tool_use block comes back", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I decided not to use the tool." }],
      usage: BASE_USAGE,
    });
    const author = new AnthropicTaskAuthor();

    const err = await author.decompose("do something", "org/repo").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedTaskAuthorError);
    const malformed = err as InstanceType<typeof MalformedTaskAuthorError>;
    expect(malformed.usage?.costUsd).toBeGreaterThan(0);
  });

  it("throws MalformedTaskAuthorError when escalate is false but steps is empty", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", name: "author_task", input: { escalate: false, steps: [] } }],
      usage: BASE_USAGE,
    });
    const author = new AnthropicTaskAuthor();

    const err = await author.decompose("do something", "org/repo").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedTaskAuthorError);
    expect((err as Error).message).toMatch(/steps/);
  });

  it("throws MalformedTaskAuthorError when escalate is true but reason is missing", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", name: "author_task", input: { escalate: true } }],
      usage: BASE_USAGE,
    });
    const author = new AnthropicTaskAuthor();

    const err = await author.decompose("do something", "org/repo").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedTaskAuthorError);
    expect((err as Error).message).toMatch(/reason/);
  });
});

describe("ScriptedTaskAuthor", () => {
  it("returns each scripted result in order, at zero cost by default", async () => {
    const author = new ScriptedTaskAuthor([
      { escalate: false, steps: [{ instruction: "i1", filePath: "a.ts" }] },
      { escalate: true, reason: "too vague" },
    ]);

    const first = await author.decompose("task 1", "org/repo");
    expect(first.result).toEqual({
      escalate: false,
      steps: [{ instruction: "i1", filePath: "a.ts" }],
    });
    expect(first.usage.costUsd).toBe(0);

    const second = await author.decompose("task 2", "org/repo");
    expect(second.result).toEqual({ escalate: true, reason: "too vague" });
  });

  it("throws once the script is exhausted", async () => {
    const author = new ScriptedTaskAuthor([{ escalate: true, reason: "x" }]);
    await author.decompose("task 1", "org/repo");

    await expect(author.decompose("task 2", "org/repo")).rejects.toThrow(/script exhausted/);
  });
});
