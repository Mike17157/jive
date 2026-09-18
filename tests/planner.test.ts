import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphReport } from "../src/core/types.ts";
import { GraphAgentController } from "../src/planner/agent.ts";
import { mergeModelOptions } from "../src/planner/models.ts";
import { OpenRouterClient } from "../src/planner/openrouter.ts";

const temporaryDirectories: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function splitSse(events: unknown[], splitEvery = 7): Response {
  const text = events
    .map((event) => event === "[DONE]" ? "data: [DONE]\r\n\r\n" : `data: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += splitEvery) {
        controller.enqueue(bytes.slice(offset, offset + splitEvery));
      }
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function toolResponse() {
  return splitSse([
    {
      model: "test/model",
      provider: "test-provider",
      choices: [{ delta: {
        reasoning_details: [{ type: "opaque", data: "keep-me" }],
        tool_calls: [{ index: 0, id: "call_", function: { name: "execute_", arguments: "{\"vers" } }],
      } }],
    },
    {
      choices: [{ delta: {
        tool_calls: [{ index: 0, id: "1", function: {
          name: "graph",
          arguments: "ion\":1,\"label\":\"streamed\",\"nodes\":{}}",
        } }],
      }, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 75, cache_write_tokens: 10 },
      },
    },
    "[DONE]",
  ]);
}

function answerResponse() {
  return splitSse([
    { model: "test/model", choices: [{ delta: { content: "All " } }] },
    {
      choices: [{ delta: { content: "done." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 90 } },
    },
    "[DONE]",
  ], 5);
}

/** A tool round that streams visible reasoning text before the call. */
function reasoningToolResponse() {
  return splitSse([
    {
      model: "test/model",
      choices: [{ delta: { reasoning: "Checking the session " } }],
    },
    {
      choices: [{ delta: {
        reasoning: "store first.",
        tool_calls: [{ index: 0, id: "1", function: {
          name: "execute_graph",
          arguments: "{\"version\":1,\"label\":\"streamed\",\"nodes\":{}}",
        } }],
      }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    "[DONE]",
  ], 7);
}

function twoToolResponse() {
  return splitSse([
    {
      model: "test/model",
      choices: [{
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "first-call",
              function: {
                name: "execute_graph",
                arguments: JSON.stringify({ version: 1, label: "first", nodes: {} }),
              },
            },
            {
              index: 1,
              id: "second-call",
              function: {
                name: "execute_graph",
                arguments: JSON.stringify({ version: 1, label: "second", nodes: {} }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      }],
    },
    "[DONE]",
  ]);
}

async function makeCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "jev-planner-test-"));
  temporaryDirectories.push(cwd);
  return cwd;
}

const toolSchema = {
  name: "execute_graph",
  description: "execute",
  parameters: { type: "object" },
};

describe("OpenRouter planner", () => {
  test("parses split SSE and fragmented tool arguments", async () => {
    const client = new OpenRouterClient({
      apiKey: "test-key",
      fetch: (async () => toolResponse()) as unknown as typeof fetch,
    });
    const result = await client.complete({
      model: "test/model",
      sessionId: "session",
      messages: [{ role: "user", content: "go" }],
      toolSchema,
    });
    expect(result.message.tool_calls).toEqual([{
      id: "call_1",
      type: "function",
      function: {
        name: "execute_graph",
        arguments: '{"version":1,"label":"streamed","nodes":{}}',
      },
    }]);
    expect(result.message.reasoning_details).toEqual([{ type: "opaque", data: "keep-me" }]);
    expect(result.usage.cachedTokens).toBe(75);
  });

  test("controller executes a streamed graph once and preserves reasoning in the tool round", async () => {
    const cwd = await makeCwd();
    const requestBodies: Array<Record<string, any>> = [];
    let fetches = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      fetches += 1;
      return fetches === 1 ? toolResponse() : answerResponse();
    }) as unknown as typeof fetch;
    let executions = 0;
    const report: GraphReport = {
      graphId: "graph-1",
      label: "streamed",
      status: "done",
      previews: [],
      requested: {},
      recordPath: join(cwd, "graph-1.json"),
    };
    const controller = new GraphAgentController({
      cwd,
      model: "test/model",
      sessionId: "stream-test",
      apiKey: "test-key",
      toolSchema,
      getPluginCatalog: async () => "plugin-a v1",
      execute: async (graph) => {
        executions += 1;
        expect(graph.label).toBe("streamed");
        return report;
      },
    });
    await controller.ready();
    await controller.submit("do the work");

    expect(executions).toBe(1);
    expect(fetches).toBe(2);
    expect(controller.getSnapshot().messages.at(-1)?.text).toBe("All done.");
    expect(controller.getSnapshot().cachedTokens).toBe(165);
    const secondAssistant = requestBodies[1]!.messages.find(
      (message: Record<string, unknown>) => message.role === "assistant" && message.tool_calls,
    );
    expect(secondAssistant.reasoning_details).toEqual([{ type: "opaque", data: "keep-me" }]);
    expect(requestBodies[0]!.session_id).toBe("stream-test");
    expect(requestBodies[0]!.provider).toEqual({ allow_fallbacks: false });
  });

  test("a tool round's reasoning becomes a transcript entry and survives a resume", async () => {
    const cwd = await makeCwd();
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return fetches === 1 ? reasoningToolResponse() : answerResponse();
    }) as unknown as typeof fetch;
    const report: GraphReport = {
      graphId: "graph-1", label: "streamed", status: "done", previews: [], requested: {},
      recordPath: join(cwd, "graph-1.json"),
    };
    const options = {
      cwd, model: "test/model", sessionId: "reasoning-test", apiKey: "test-key", toolSchema,
      getPluginCatalog: async () => "plugin-a v1",
      execute: async () => report,
    };
    const controller = new GraphAgentController(options);
    await controller.ready();
    await controller.submit("do the work");

    const roles = controller.getSnapshot().messages.map((m) => m.role);
    expect(roles).toEqual(["user", "thinking", "assistant"]);
    const thinking = controller.getSnapshot().messages[1]!;
    expect(thinking.text).toBe("Checking the session store first.");

    // The same rows come back when the session is reopened.
    const resumed = new GraphAgentController(options);
    await resumed.ready();
    const restored = resumed.getSnapshot().messages;
    expect(restored.map((m) => m.role)).toEqual(["user", "thinking", "assistant"]);
    expect(restored[1]!.text).toBe("Checking the session store first.");
    expect(restored[1]!.id).toBe(thinking.id);
  });

  test("reasoning that arrives after the reply is placed above it and empty content deltas leave no entry", async () => {
    const cwd = await makeCwd();
    globalThis.fetch = (async () => splitSse([
      { choices: [{ delta: { role: "assistant", content: "" } }] },
      { choices: [{ delta: { content: "The fix " } }] },
      { choices: [{ delta: { content: "is in place." } }] },
      { choices: [{ delta: { reasoning: "Reviewing the earlier runs." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
      "[DONE]",
    ])) as unknown as typeof fetch;
    const controller = new GraphAgentController({
      cwd, model: "test/model", sessionId: "late-reasoning", apiKey: "test-key", toolSchema,
      getPluginCatalog: async () => "", execute: async () => { throw new Error("no graph expected"); },
    });
    await controller.ready();
    await controller.submit("fix it");
    const messages = controller.getSnapshot().messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "thinking", "assistant"]);
    expect(messages[1]!.text).toBe("Reviewing the earlier runs.");
    expect(messages[2]!.text).toBe("The fix is in place.");
  });

  test("does not retry an executed graph when the following transport call fails", async () => {
    const cwd = await makeCwd();
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches === 1) return toolResponse();
      throw new Error("network vanished");
    }) as unknown as typeof fetch;
    let executions = 0;
    const controller = new GraphAgentController({
      cwd,
      model: "test/model",
      sessionId: "no-retry-test",
      apiKey: "test-key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => {
        executions += 1;
        return {
          graphId: "graph-once",
          label: "streamed",
          status: "done",
          previews: [],
          requested: {},
          recordPath: "record.json",
        };
      },
    });
    await controller.ready();
    await controller.submit("execute once");

    expect(executions).toBe(1);
    expect(fetches).toBe(2);
    expect(controller.getSnapshot().error).toContain("Could not reach OpenRouter");
    const raw = await readFile(join(cwd, ".jev", "sessions", "no-retry-test", "session.jsonl"), "utf8");
    const records = raw.trim().split("\n").map(line=>JSON.parse(line));
    expect(records.filter(event=>event.type==="graph.started")).toHaveLength(1);
    expect(records.filter(event=>event.type==="graph.finished")).toHaveLength(1);
  });

  test("cancellation closes every emitted tool call before the next user message", async () => {
    const cwd = await makeCwd();
    const requestBodies: Array<Record<string, any>> = [];
    let fetches = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      fetches += 1;
      return fetches === 1 ? twoToolResponse() : answerResponse();
    }) as unknown as typeof fetch;

    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let executions = 0;
    const controller = new GraphAgentController({
      cwd,
      model: "test/model",
      sessionId: "cancel-batch-test",
      apiKey: "test-key",
      toolSchema,
      getPluginCatalog: async () => "stable catalog",
      execute: async (_graph, signal) => {
        executions += 1;
        signalStarted();
        return await new Promise<GraphReport>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    await controller.ready();
    const firstSubmit = controller.submit("start both graphs");
    await started;
    controller.interrupt();
    await firstSubmit;

    const closedResults = controller.store.plannerMessageEvents()
      .map((event) => event.data.message)
      .filter((message) => message.role === "tool");
    expect(closedResults.map((message) => message.tool_call_id)).toEqual([
      "first-call",
      "second-call",
    ]);
    expect(closedResults[1]?.content).toContain('"status":"cancelled"');

    await controller.submit("decide recovery safely");
    expect(executions).toBe(1);
    expect(fetches).toBe(2);
    const messages = requestBodies[1]!.messages as Array<Record<string, any>>;
    const assistantIndex = messages.findIndex((message) => message.tool_calls?.length === 2);
    expect(messages[assistantIndex + 1]?.tool_call_id).toBe("first-call");
    expect(messages[assistantIndex + 2]?.tool_call_id).toBe("second-call");
    expect(messages.slice(assistantIndex + 3).some(
      (message) => message.role === "user" && message.content === "decide recovery safely",
    )).toBe(true);
  });

  test("publishes a changed plugin catalog before the next planning request", async () => {
    const cwd = await makeCwd();
    const requestBodies: Array<Record<string, any>> = [];
    let fetches = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      fetches += 1;
      return fetches === 1 ? toolResponse() : answerResponse();
    }) as unknown as typeof fetch;
    let catalogReads = 0;
    const controller = new GraphAgentController({
      cwd,
      model: "test/model",
      sessionId: "plugin-refresh-test",
      apiKey: "test-key",
      toolSchema,
      getPluginCatalog: async () => ++catalogReads === 1 ? "plugin-a v1" : "plugin-a v1\nplugin-new v1",
      execute: async () => ({
        graphId: "plugin-authoring-graph",
        label: "streamed",
        status: "done",
        previews: [],
        requested: {},
        recordPath: "record.json",
      }),
    });
    await controller.ready();
    await controller.submit("author then use a plugin");

    expect(catalogReads).toBe(2);
    expect(requestBodies[1]!.messages.some(
      (message: Record<string, unknown>) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("plugin-new v1"),
    )).toBe(true);
    expect(controller.store.events.filter((event) => event.type === "plugin.catalog")).toHaveLength(2);
  });

  test("uses only reasoning efforts returned by model metadata", () => {
    const models = mergeModelOptions({
      fetchedAt: "2026-09-18T00:00:00.000Z",
      models: [
        {
          id: "openai/gpt-6-astra",
          supported_parameters: ["tools", "reasoning"],
          reasoning: { supported_efforts: ["minimal", "medium", "xhigh"] },
        },
        {
          id: "openai/gpt-5.6-sol",
          supported_parameters: ["tools", "reasoning"],
        },
      ],
    });
    expect(models.find((model) => model.id === "openai/gpt-6-astra")?.reasoningEfforts)
      .toEqual(["minimal", "medium", "xhigh"]);
    expect(models.find((model) => model.id === "openai/gpt-5.6-sol")?.reasoningEfforts)
      .toEqual([]);
  });

  test("missing key is actionable and never reports fake success", async () => {
    const cwd = await makeCwd();
    const oldKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const controller = new GraphAgentController({
        cwd,
        model: "test/model",
        sessionId: "no-key-test",
        toolSchema,
        getPluginCatalog: async () => "",
        execute: async () => { throw new Error("must not execute"); },
      });
      await controller.ready();
      await controller.submit("hello");
      expect(controller.getSnapshot().error).toContain("OPENROUTER_API_KEY");
      expect(controller.getSnapshot().messages.at(-1)?.role).toBe("notice");
    } finally {
      if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = oldKey;
    }
  });

  function graphCallResponse(argumentsText: string) {
    return splitSse([
      { model: "test/model", choices: [{ delta: {
        tool_calls: [{ index: 0, id: "call-1", function: { name: "execute_graph", arguments: argumentsText } }],
      }, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
  }

  async function runOneGraph(argumentsText: string, execute: (graph: any) => Promise<GraphReport>) {
    const cwd = await makeCwd();
    const bodies: Array<Record<string, any>> = [];
    let fetches = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return ++fetches === 1 ? graphCallResponse(argumentsText) : answerResponse();
    }) as unknown as typeof fetch;
    const controller = new GraphAgentController({
      cwd, model: "test/model", sessionId: "repair-test", apiKey: "test-key", toolSchema,
      getPluginCatalog: async () => "", execute,
    });
    await controller.ready();
    await controller.submit("go");
    const toolMessage = bodies[1]!.messages.find((message: Record<string, unknown>) => message.role === "tool");
    return { controller, toolResult: JSON.parse(toolMessage.content) };
  }

  test("repairs a string version and JSON-encoded nodes, executes, and tells the model what changed", async () => {
    const sent = JSON.stringify({ version: "1", label: "repaired", nodes: JSON.stringify({ a: { type: "bash", script: "ls" } }) });
    const executed: any[] = [];
    const { controller, toolResult } = await runOneGraph(sent, async (graph) => {
      executed.push(graph);
      return { graphId: "g", label: graph.label, status: "done", previews: [], requested: {}, recordPath: "/dev/null" };
    });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual({ version: 1, label: "repaired", nodes: { a: { type: "bash", script: "ls" } } });
    expect(toolResult.status).toBe("done");
    expect(toolResult.repairs).toEqual([
      '/version: coerced the string "1" to the number 1. Send the corrected shape next time.',
      "/nodes: parsed a JSON-encoded string into an object; send an object directly. Send the corrected shape next time.",
    ]);
    expect(controller.getSnapshot().error).toBeUndefined();
  });

  test("schema rejections carry a readable message, a hint, and a minimal example", async () => {
    const { toolResult } = await runOneGraph("{}", async () => { throw new Error("must not execute"); });
    expect(toolResult.status).toBe("error");
    expect(toolResult.error).toBe(
      'Invalid graph: / is missing required property "version"; / is missing required property "label"; / is missing required property "nodes"',
    );
    expect(toolResult.hint).toContain("version is the JSON number 1");
    expect(toolResult.example).toEqual({ version: 1, label: "List files", nodes: { list: { type: "bash", script: "ls -la" } }, returns: ["list"] });
  });

  test("rejected node types are reported once with the allowed options", async () => {
    const sent = JSON.stringify({ version: 2, label: "bad", nodes: { a: { type: "shell", script: "ls" } } });
    const { toolResult } = await runOneGraph(sent, async () => { throw new Error("must not execute"); });
    expect(toolResult.error).toBe(
      'Invalid graph: /version must be the number 1 (received the number 2); /nodes/a/type must be one of "bash", "jev" (received the string "shell")',
    );
    expect(toolResult.hint).toBeDefined();
  });
});
