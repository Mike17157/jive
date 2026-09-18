import { expect, test } from "bun:test";
import { OpenRouterClient } from "../src/planner/openrouter";

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
