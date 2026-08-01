/**
 * The executor role: qwen2.5:3b rewrites one whole file per atomic
 * instruction. Full-file rewrite via plain text completion only — no tools
 * array, no tool-calling loop (CONTEXT.md: a 3B model's tool-calling
 * reliability is an unproven risk this design deliberately avoids). The
 * harness sends the current file content + one instruction; qwen returns
 * the complete new file content between explicit markers this prompt asks
 * it to use, and the harness writes it back verbatim.
 */

export interface RewriteResult {
  newContent: string;
}

export interface Executor {
  rewrite(instruction: string, currentFileContent: string): Promise<RewriteResult>;
}

/** Hardcoded for v1 — no config surface for swapping models (CONTEXT.md). */
export const OLLAMA_MODEL = "qwen2.5:3b";

/** Default local Ollama server address, matching Ollama's own `OLLAMA_HOST` convention. */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

const FILE_START_MARKER = "<<<REEVE_FILE_START>>>";
const FILE_END_MARKER = "<<<REEVE_FILE_END>>>";

/**
 * Upfront persona-priming (CONTEXT.md: "the same principle applies" as the
 * reviewer prompt) — told explicitly it's a 3B local model, so the
 * instruction it receives is expected to already be atomic and literal, not
 * something it has to interpret or plan around.
 */
function buildSystemPrompt(): string {
  return [
    "You are a small local code-editing model. You are given the complete current contents of one file and a single, literal, mechanical instruction describing exactly one change to make.",
    "Make only the change described. Do not fix unrelated issues, do not reformat unrelated code, do not add comments explaining your change.",
    `Respond with the complete new file content, and nothing else, between the markers ${FILE_START_MARKER} and ${FILE_END_MARKER}. Do not include any text before ${FILE_START_MARKER} or after ${FILE_END_MARKER}.`,
  ].join("\n\n");
}

function buildUserPrompt(instruction: string, currentFileContent: string): string {
  return [
    `Instruction: ${instruction}`,
    `Current file content:\n${FILE_START_MARKER}\n${currentFileContent}\n${FILE_END_MARKER}`,
    `Now output the complete new file content between ${FILE_START_MARKER} and ${FILE_END_MARKER}.`,
  ].join("\n\n");
}

export class MalformedRewriteError extends Error {
  constructor(reason: string) {
    super(`Executor returned a malformed rewrite: ${reason}`);
    this.name = "MalformedRewriteError";
  }
}

function parseRewrite(content: string): string {
  const startIndex = content.indexOf(FILE_START_MARKER);
  const endIndex = content.indexOf(FILE_END_MARKER);
  if (startIndex === -1 || endIndex === -1) {
    throw new MalformedRewriteError(`missing ${FILE_START_MARKER}/${FILE_END_MARKER} markers`);
  }
  if (endIndex < startIndex) {
    throw new MalformedRewriteError("end marker appeared before start marker");
  }
  const newContent = content
    .slice(startIndex + FILE_START_MARKER.length, endIndex)
    .replace(/^\n/, "");
  if (newContent.trim().length === 0) {
    throw new MalformedRewriteError("rewritten content between markers was empty");
  }
  return newContent;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

export class OllamaExecutor implements Executor {
  private readonly baseUrl: string;

  constructor(
    readonly model: string = OLLAMA_MODEL,
    baseUrl?: string,
  ) {
    this.baseUrl = baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_BASE_URL;
  }

  async rewrite(instruction: string, currentFileContent: string): Promise<RewriteResult> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(instruction, currentFileContent) },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Ollama request to ${this.baseUrl} failed: ${response.status} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as OllamaChatResponse;
    const content = body.message?.content;
    if (!content) {
      throw new MalformedRewriteError("no message content in Ollama response");
    }
    return { newContent: parseRewrite(content) };
  }
}

/** Scripted/mocked executor for testing loop mechanics without a real qwen call. */
export class ScriptedExecutor implements Executor {
  private index = 0;

  constructor(private readonly script: string[]) {}

  async rewrite(): Promise<RewriteResult> {
    const newContent = this.script[this.index];
    if (newContent === undefined) {
      throw new Error(`ScriptedExecutor script exhausted after ${this.index} calls`);
    }
    this.index++;
    return { newContent };
  }
}
