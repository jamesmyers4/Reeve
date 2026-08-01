import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OLLAMA_BASE_URL,
  MalformedRewriteError,
  OLLAMA_MODEL,
  OllamaExecutor,
  ScriptedExecutor,
} from "../../src/providers/executor.js";

function ollamaResponse(content: string): Response {
  return new Response(JSON.stringify({ message: { content } }), { status: 200 });
}

describe("OllamaExecutor", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hardcodes qwen2.5:3b and the local Ollama address by default", () => {
    const executor = new OllamaExecutor();
    expect(executor.model).toBe(OLLAMA_MODEL);
    expect(DEFAULT_OLLAMA_BASE_URL).toBe("http://localhost:11434");
  });

  it("posts a system+user prompt with no tools array, and parses content between the file markers", async () => {
    fetchMock.mockResolvedValueOnce(
      ollamaResponse(
        "some preamble\n<<<REEVE_FILE_START>>>\nexport function bar() {}\n<<<REEVE_FILE_END>>>\ntrailer",
      ),
    );
    const executor = new OllamaExecutor();

    const result = await executor.rewrite("Remove the unused foo variable.", "const foo = 1;\n");

    expect(result.newContent).toBe("export function bar() {}\n");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe(OLLAMA_MODEL);
    expect(body.tools).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: expect.any(String) },
      { role: "user", content: expect.any(String) },
    ]);
  });

  it("throws MalformedRewriteError when the response has no file markers", async () => {
    fetchMock.mockResolvedValueOnce(ollamaResponse("I rewrote the file but forgot the markers."));
    const executor = new OllamaExecutor();

    await expect(executor.rewrite("do a thing", "content")).rejects.toThrow(MalformedRewriteError);
  });

  it("throws MalformedRewriteError when the content between markers is empty", async () => {
    fetchMock.mockResolvedValueOnce(
      ollamaResponse("<<<REEVE_FILE_START>>>\n\n<<<REEVE_FILE_END>>>"),
    );
    const executor = new OllamaExecutor();

    await expect(executor.rewrite("do a thing", "content")).rejects.toThrow(MalformedRewriteError);
  });

  it("throws MalformedRewriteError when the response has no message content at all", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const executor = new OllamaExecutor();

    await expect(executor.rewrite("do a thing", "content")).rejects.toThrow(MalformedRewriteError);
  });

  it("throws a plain error when the HTTP request itself fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("server exploded", { status: 500 }));
    const executor = new OllamaExecutor();

    await expect(executor.rewrite("do a thing", "content")).rejects.toThrow(/500/);
  });

  it("respects an explicit baseUrl override", async () => {
    fetchMock.mockResolvedValueOnce(
      ollamaResponse("<<<REEVE_FILE_START>>>\nnew content\n<<<REEVE_FILE_END>>>"),
    );
    const executor = new OllamaExecutor(OLLAMA_MODEL, "http://custom-host:1234");

    await executor.rewrite("do a thing", "content");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://custom-host:1234/api/chat");
  });
});

describe("ScriptedExecutor", () => {
  it("returns each scripted rewrite in order", async () => {
    const executor = new ScriptedExecutor(["first content", "second content"]);

    await expect(executor.rewrite("i1", "before1")).resolves.toEqual({
      newContent: "first content",
    });
    await expect(executor.rewrite("i2", "before2")).resolves.toEqual({
      newContent: "second content",
    });
  });

  it("throws once the script is exhausted", async () => {
    const executor = new ScriptedExecutor(["only content"]);
    await executor.rewrite("i1", "before1");

    await expect(executor.rewrite("i2", "before2")).rejects.toThrow(/script exhausted/);
  });
});
