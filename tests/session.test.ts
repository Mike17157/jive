import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeContext, runtimeContextMessage } from "../src/planner/runtime-context.ts";

import {
  DeterministicContext,
  excerptOversizedOutput,
  SessionStore,
  type PlannerMessage,
} from "../src/session/index.ts";

const temporaryDirectories: string[] = [];

async function temporaryStore(sessionId = "test-session"): Promise<SessionStore> {
  const cwd = await mkdtemp(join(tmpdir(), "jev-session-test-"));
  temporaryDirectories.push(cwd);
  const store = new SessionStore({ cwd, sessionId });
  await store.initialize();
  return store;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("append-only session context", () => {
  test("compaction preserves the authoritative runtime prefix and latest extractor contracts", async () => {
    const store = await temporaryStore("runtime-compaction");
    const prefix: PlannerMessage[] = [
      { role: "system", content: "stable operating policy" },
      { role: "system", content: runtimeContextMessage(runtimeContext(store.cwd, false, {})) },
    ];
    await store.appendMessage({ role: "system", content: "Extractor plugin catalog update (append-only):\nold catalog" });
    await store.appendMessage({ role: "user", content: "original task" });
    for (let i = 0; i < 20; i++) await store.appendMessage({ role: "assistant", content: "old evidence ".repeat(100) });
    await store.appendMessage({ role: "system", content: "Extractor plugin catalog update (append-only):\ncurrent catalog" });
    await store.appendMessage({ role: "assistant", content: "latest result" });
    const prepared = await new DeterministicContext(store, prefix, { contextLimit: 3000, outputReserve: 200, toolResultReserve: 200, retentionRatio: 0.1 }).prepare();
    expect(prepared.compacted).toBe(true);
    expect(prepared.messages.slice(0, 2)).toEqual(prefix);
    expect(prepared.messages.some(m => m.content?.includes("current catalog"))).toBe(true);
    expect(prepared.messages.some(m => m.content?.includes("old catalog"))).toBe(false);
  });
  test("keeps the exact request prefix stable as turns append", async () => {
    const store = await temporaryStore();
    const prefix: PlannerMessage[] = [{ role: "system", content: "stable instructions" }];
    await store.appendMessage({ role: "user", content: "original task" });
    const context = new DeterministicContext(store, prefix, {
      contextLimit: 8_000,
      outputReserve: 500,
      toolResultReserve: 500,
    });
    const first = await context.prepare();

    await store.appendMessage({ role: "assistant", content: "first answer" });
    const second = await context.prepare();

    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.messages.at(-1)?.content).toBe("first answer");
  });

  test("compaction retains task, pins, and complete tool pairs verbatim", async () => {
    const store = await temporaryStore();
    await store.appendMessage({ role: "user", content: "ORIGINAL TASK — retain exactly" });
    await store.appendMessage({ role: "assistant", content: "ack" });
    await store.addPin("NEVER overwrite generated fixtures");
    for (let index = 0; index < 10; index += 1) {
      await store.appendMessage({ role: "user", content: `old-${index} ${"x".repeat(360)}` });
      await store.appendMessage({ role: "assistant", content: `old-answer-${index}` });
    }
    await store.appendMessage({ role: "user", content: "latest turn" });
    await store.appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-pair",
        type: "function",
        function: { name: "execute_graph", arguments: "{\"version\":1}" },
      }],
    });
    await store.appendMessage({
      role: "tool",
      name: "execute_graph",
      tool_call_id: "call-pair",
      content: "tool-result-verbatim",
    });
    await store.appendMessage({ role: "assistant", content: "latest answer" });

    const prepared = await new DeterministicContext(
      store,
      [{ role: "system", content: "stable" }],
      {
        contextLimit: 1_100,
        outputReserve: 100,
        toolResultReserve: 100,
        retentionRatio: 0.16,
      },
    ).prepare();

    expect(prepared.compacted).toBe(true);
    expect(prepared.messages.some((message) => message.content === "ORIGINAL TASK — retain exactly")).toBe(true);
    expect(prepared.messages.some((message) => message.content?.includes("NEVER overwrite generated fixtures"))).toBe(true);
    expect(prepared.messages.some((message) => message.content?.includes("no model summary was generated"))).toBe(true);
    const callIndex = prepared.messages.findIndex((message) => message.tool_calls?.[0]?.id === "call-pair");
    const resultIndex = prepared.messages.findIndex((message) => message.tool_call_id === "call-pair");
    expect(callIndex).toBeGreaterThan(-1);
    expect(resultIndex).toBeGreaterThan(callIndex);
    expect(prepared.messages[resultIndex]?.content).toBe("tool-result-verbatim");
  });

  test("one autonomous user turn compacts between complete tool exchanges", async () => {
    const store = await temporaryStore();
    await store.appendMessage({ role: "user", content: "ONE LONG AUTONOMOUS TASK" });
    await store.addPin("KEEP THIS EXACT CONSTRAINT");
    for (let index = 0; index < 8; index += 1) {
      await store.appendMessage({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `round-${index}`,
          type: "function",
          function: { name: "execute_graph", arguments: JSON.stringify({ round: index }) },
        }],
      });
      await store.appendMessage({
        role: "tool",
        name: "execute_graph",
        tool_call_id: `round-${index}`,
        content: `result-${index}-${"e".repeat(1_000)}`,
      });
    }

    const prepared = await new DeterministicContext(
      store,
      [{ role: "system", content: "stable" }],
      {
        contextLimit: 1_400,
        outputReserve: 100,
        toolResultReserve: 100,
        retentionRatio: 0.2,
      },
    ).prepare();

    expect(prepared.compacted).toBe(true);
    expect(prepared.messages.some((message) => message.content === "ONE LONG AUTONOMOUS TASK")).toBe(true);
    expect(prepared.messages.some((message) => message.content?.includes("KEEP THIS EXACT CONSTRAINT"))).toBe(true);
    const retainedCalls = prepared.messages.flatMap((message) => message.tool_calls ?? []);
    const resultIds = new Set(
      prepared.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
    );
    expect(retainedCalls.length).toBeGreaterThan(0);
    expect(retainedCalls.length).toBeLessThan(8);
    expect(retainedCalls.some((call) => call.id === "round-0")).toBe(false);
    expect(retainedCalls.some((call) => call.id === "round-7")).toBe(true);
    for (const call of retainedCalls) expect(resultIds.has(call.id)).toBe(true);
  });

  test("full archive is searchable after compaction", async () => {
    const store = await temporaryStore();
    await store.appendMessage({ role: "user", content: "needle-from-early-evidence" });
    await store.appendMessage({ role: "assistant", content: "done" });
    await store.appendMessage({ role: "user", content: "later" });

    expect(store.search("NEEDLE-from-early")).toHaveLength(1);
    expect(store.search("needle-from-early")[0]?.event.type).toBe("planner.message");
  });

  test("restoration marks incomplete calls interrupted exactly once", async () => {
    const first = await temporaryStore("restart-session");
    await first.appendMessage({ role: "user", content: "run it" });
    await first.appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "unfinished-call",
        type: "function",
        function: {
          name: "execute_graph",
          arguments: JSON.stringify({ version: 1, label: "unfinished", nodes: {} }),
        },
      }],
    });
    await first.append("graph.started", {
      callId: "unfinished-call",
      graphId: "graph-before-crash",
      graph: { version: 1, label: "unfinished", nodes: {} },
    });

    const restored = new SessionStore({ cwd: first.cwd, sessionId: "restart-session" });
    await restored.initialize();
    const recovered = await restored.recoverInterruptedToolCalls();
    expect(recovered).toEqual([expect.objectContaining({ callId: "unfinished-call", started: true })]);
    const result = restored.plannerMessageEvents().find(
      (event) => event.data.message.role === "tool" && event.data.message.tool_call_id === "unfinished-call",
    );
    expect(result?.data.message.content).toContain('"status":"interrupted"');
    expect(restored.events.filter((event) => event.type === "graph.interrupted")).toHaveLength(1);
    expect(await restored.recoverInterruptedToolCalls()).toEqual([]);
  });

  test("oversized values are explicitly excerpted with a recoverable artifact", async () => {
    const store = await temporaryStore();
    const full = JSON.stringify({ output: "z".repeat(8_000) });
    const excerpt = await excerptOversizedOutput(store, "large.json", full, 700);
    expect(excerpt).toContain("NOT COMPLETE");
    expect(excerpt).toContain("Full output");
    const artifactEvent = store.events.findLast((event) => event.type === "artifact.saved");
    expect(artifactEvent).toBeDefined();
    const restored = new TextDecoder().decode(await store.readArtifact(String(artifactEvent!.data.relativePath)));
    expect(restored).toBe(full);
  });

  test("repairs a partial JSONL tail by UTF-8 byte length", async () => {
    const first = await temporaryStore("unicode-repair");
    const unicode = "Résumé 東京 🚀 — evidence";
    await first.appendMessage({ role: "user", content: unicode });
    await first.flush();
    await appendFile(first.logPath, '{"partial":"破損', "utf8");

    const restored = new SessionStore({ cwd: first.cwd, sessionId: "unicode-repair" });
    await restored.initialize();
    expect(restored.plannerMessageEvents()[0]?.data.message.content).toBe(unicode);
    await restored.appendMessage({ role: "assistant", content: "valid after repair" });
    await restored.flush();

    const lines = (await readFile(restored.logPath, "utf8")).trim().split("\n");
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed.some((event) => event.data?.message?.content === unicode)).toBe(true);
    expect(parsed.some((event) => event.data?.message?.content === "valid after repair")).toBe(true);
  });
});
