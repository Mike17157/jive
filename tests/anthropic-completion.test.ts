import { expect, test } from "bun:test";
import {
  AnthropicClient,
  anthropicModelId,
  isDirectAnthropicModel,
  resolveAnthropicCredential,
} from "../src/planner/anthropic";

function sse(events: Array<{ event?: string; data: unknown }>): Response {
  const body = events.map(({ event, data }) =>
    `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`,
  ).join("");
  return new Response(body);
}

/** A minimal but complete tool-call stream: one execute_graph call, then stop. */
function toolCallStream(argumentsJson: string) {
  return sse([
    { data: { type: "message_start", message: { usage: { input_tokens: 100 } } } },
    { data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "execute_graph", input: {} } } },
    { data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: argumentsJson } } },
    { data: { type: "content_block_stop", index: 0 } },
    { data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } } },
    { data: { type: "message_stop" } },
  ]);
}

function textStream(text: string) {
  return sse([
    { data: { type: "message_start", message: { usage: { input_tokens: 50 } } } },
    { data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
    { data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { data: { type: "content_block_stop", index: 0 } },
    { data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } },
    { data: { type: "message_stop" } },
  ]);
}

test("ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY, matching Claude Code's own precedence", () => {
  expect(resolveAnthropicCredential({ ANTHROPIC_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "key" } as NodeJS.ProcessEnv))
    .toEqual({ kind: "oauth", value: "tok" });
  expect(resolveAnthropicCredential({ ANTHROPIC_API_KEY: "key" } as NodeJS.ProcessEnv))
    .toEqual({ kind: "api-key", value: "key" });
  expect(resolveAnthropicCredential({} as NodeJS.ProcessEnv)).toBeUndefined();
});

test("only anthropic/claude-* selections route to the direct client", () => {
  expect(isDirectAnthropicModel("anthropic/claude-sonnet-5")).toBe(true);
  expect(isDirectAnthropicModel("openai/gpt-6-sol")).toBe(false);
  expect(anthropicModelId("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
});

test("an OAuth token authenticates with a bearer header and the oauth beta flag; a plain key uses x-api-key", async () => {
  const headersSeen: Record<string, string>[] = [];
  const capture = (init: RequestInit) => headersSeen.push(init.headers as Record<string, string>);

  const oauthClient = new AnthropicClient({
    credential: { kind: "oauth", value: "sk-oauth" },
    fetch: (async (_url: unknown, init: RequestInit) => { capture(init); return textStream("hi"); }) as unknown as typeof fetch,
  });
  await oauthClient.complete({ model: "anthropic/claude-sonnet-5", sessionId: "t", messages: [], toolSchema: {} });

  const keyClient = new AnthropicClient({
    credential: { kind: "api-key", value: "sk-key" },
    fetch: (async (_url: unknown, init: RequestInit) => { capture(init); return textStream("hi"); }) as unknown as typeof fetch,
  });
  await keyClient.complete({ model: "anthropic/claude-sonnet-5", sessionId: "t", messages: [], toolSchema: {} });

  expect(headersSeen[0]!.Authorization).toBe("Bearer sk-oauth");
  expect(headersSeen[0]!["anthropic-beta"]).toBe("oauth-2025-04-20");
  expect(headersSeen[0]!["x-api-key"]).toBeUndefined();

  expect(headersSeen[1]!["x-api-key"]).toBe("sk-key");
  expect(headersSeen[1]!.Authorization).toBeUndefined();
  expect(headersSeen[1]!["anthropic-beta"]).toBeUndefined();
});

test("the request always leads with the identity system block the OAuth path requires", async () => {
  const bodies: any[] = [];
  const client = new AnthropicClient({
    credential: { kind: "api-key", value: "sk-key" },
    fetch: (async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return textStream("hi"); }) as unknown as typeof fetch,
  });
  await client.complete({
    model: "anthropic/claude-sonnet-5", sessionId: "t",
    messages: [{ role: "system", content: "You are Jive." }],
    toolSchema: {},
  });
  expect(bodies[0].system[0]).toEqual({ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." });
  expect(bodies[0].system[1].text).toBe("You are Jive.");
});

test("a streamed tool_use block becomes a PlannerMessage tool call with valid arguments", async () => {
  const client = new AnthropicClient({
    credential: { kind: "api-key", value: "sk-key" },
    fetch: (async () => toolCallStream(JSON.stringify({ version: 1, nodes: {} }))) as unknown as typeof fetch,
  });
  const result = await client.complete({
    model: "anthropic/claude-sonnet-5", sessionId: "t", messages: [],
    toolSchema: { name: "execute_graph", parameters: { type: "object" } },
  });
  expect(result.finishReason).toBe("tool_calls");
  expect(result.message.tool_calls).toHaveLength(1);
  expect(result.message.tool_calls![0]!.function.name).toBe("execute_graph");
  expect(JSON.parse(result.message.tool_calls![0]!.function.arguments)).toEqual({ version: 1, nodes: {} });
  expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 12, totalTokens: 112, cachedTokens: 0, cacheWriteTokens: 0 });
});

test("the mapped thinking budget is sent for a supported effort level and omitted otherwise", async () => {
  const bodies: any[] = [];
  const client = new AnthropicClient({
    credential: { kind: "api-key", value: "sk-key" },
    fetch: (async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return textStream("hi"); }) as unknown as typeof fetch,
  });
  await client.complete({ model: "anthropic/claude-sonnet-5", sessionId: "t", messages: [], toolSchema: {}, effort: "low" });
  await client.complete({ model: "anthropic/claude-sonnet-5", sessionId: "t", messages: [], toolSchema: {}, effort: "none" });
  await client.complete({ model: "anthropic/claude-sonnet-5", sessionId: "t", messages: [], toolSchema: {} });
  expect(bodies[0].thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  expect(bodies[0].max_tokens).toBe(2048 + 16_000);
  expect(bodies[1]).not.toHaveProperty("thinking");
  expect(bodies[2]).not.toHaveProperty("thinking");
});

test("truncated or refused completions cannot yield an executable graph", async () => {
  const maxTokensStream = sse([
    { data: { type: "message_start", message: { usage: { input_tokens: 10 } } } },
    { data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "execute_graph", input: {} } } },
    { data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"version\":1" } } },
    { data: { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } } },
    { data: { type: "message_stop" } },
  ]);
  const client = new AnthropicClient({
    credential: { kind: "api-key", value: "sk-key" },
    fetch: (async () => maxTokensStream) as unknown as typeof fetch,
  });
  await expect(client.complete({ model: "anthropic/claude-sonnet-5", sessionId: "t", messages: [], toolSchema: {} }))
    .rejects.toThrow(/before the full tool call was accepted/);
});

test("a transient overloaded_error is retried until the API answers", async () => {
  let attempts = 0;
  const client = new AnthropicClient({
    credential: { kind: "api-key", value: "sk-key" },
    retry: { attempts: 4, baseDelayMs: 1, maxDelayMs: 2 },
    fetch: (async () => {
      attempts += 1;
      return attempts < 3
        ? sse([{ data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }])
        : textStream("hi");
    }) as unknown as typeof fetch,
  });
  const result = await client.complete({ model: "anthropic/claude-sonnet-5", sessionId: "t", messages: [], toolSchema: {} });
  expect(attempts).toBe(3);
  expect(result.message.content).toBe("hi");
});
