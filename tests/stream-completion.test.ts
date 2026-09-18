import { expect, test } from "bun:test";
import { OpenRouterClient, reasoningParameters } from "../src/planner/openrouter";

function completion(finishReason?: string, tool = true) {
  const chunk = { choices: [{
    delta: tool ? { tool_calls: [{ index: 0, id: "call-1", function: {
      name: "execute_graph", arguments: JSON.stringify({ version: 1, nodes: {} }),
    } }] } : { reasoning: "Still thinking" },
    finish_reason: finishReason,
  }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

test("truncated or filtered completions cannot yield executable graphs even with valid JSON", async () => {
  for (const reason of ["length", "content_filter", "error", undefined]) {
    const client = new OpenRouterClient({
      apiKey: "test", fetch: (async () => completion(reason)) as unknown as typeof fetch,
    });
    await expect(client.complete({
      model: "test", sessionId: "test", messages: [],
      toolSchema: { name: "execute_graph", parameters: { type: "object" } },
    })).rejects.toThrow(/before the full tool call was accepted|did not confirm/);
  }
});

test("reasoning without an answer or tool call does not silently finish the task", async () => {
  const client = new OpenRouterClient({
    apiKey: "test", fetch: (async () => completion("stop", false)) as unknown as typeof fetch,
  });
  await expect(client.complete({ model: "test", sessionId: "test", messages: [], toolSchema: {} }))
    .rejects.toThrow("no answer or tool call");
});

test("Anthropic models get an explicit thinking budget per level; other models get the effort name", () => {
  expect(reasoningParameters("anthropic/claude-sonnet-5", "low")).toEqual({ max_tokens: 2048 });
  expect(reasoningParameters("anthropic/claude-sonnet-5", "medium")).toEqual({ max_tokens: 6144 });
  expect(reasoningParameters("anthropic/claude-sonnet-5", "max")).toEqual({ max_tokens: 32768 });
  expect(reasoningParameters("anthropic/claude-sonnet-5", "none")).toEqual({ enabled: false });
  expect(reasoningParameters("openai/gpt-5.6-sol", "low")).toEqual({ effort: "low" });
  expect(reasoningParameters("google/gemini-3.8-flash", "high")).toEqual({ effort: "high" });
  expect(reasoningParameters("anthropic/claude-sonnet-5", undefined)).toBeUndefined();
});

test("the request body carries the mapped reasoning object", async () => {
  const bodies: any[] = [];
  const client = new OpenRouterClient({
    apiKey: "test",
    fetch: (async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return completion("stop"); }) as unknown as typeof fetch,
  });
  await client.complete({ model: "anthropic/claude-sonnet-5", sessionId: "t", messages: [], toolSchema: {}, effort: "low" }).catch(() => undefined);
  await client.complete({ model: "openai/gpt-5.6-sol", sessionId: "t", messages: [], toolSchema: {}, effort: "low" }).catch(() => undefined);
  await client.complete({ model: "openai/gpt-5.6-sol", sessionId: "t", messages: [], toolSchema: {} }).catch(() => undefined);
  expect(bodies[0].reasoning).toEqual({ max_tokens: 2048 });
  expect(bodies[1].reasoning).toEqual({ effort: "low" });
  expect(bodies[2]).not.toHaveProperty("reasoning");
});
