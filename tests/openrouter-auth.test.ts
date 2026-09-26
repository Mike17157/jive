import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { promptOpenRouterApiKey, type PromptOpenRouterApiKeyOptions } from "../src/planner/openrouter-auth";
import { upsertEnvVariable } from "../src/core/env-file";

/** A minimal interactive-terminal stand-in for stdin/stdout, since bun test's own are not TTYs. */
function fakeTty(overrides: { stdinIsTTY?: boolean; stdoutIsTTY?: boolean } = {}) {
  const writes: string[] = [];
  const rawModeCalls: boolean[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: overrides.stdinIsTTY ?? true,
    isRaw: false,
    setRawMode(enabled: boolean) { rawModeCalls.push(enabled); },
    resume() {},
    pause() {},
  });
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: overrides.stdoutIsTTY ?? true,
    write(data: string) { writes.push(data); return true; },
  });
  return { stdin, stdout, writes, rawModeCalls };
}

/** Emits `text` as stdin "data" events, one character at a time, like a real keyboard. */
function type(stdin: EventEmitter, text: string) {
  for (const char of text) stdin.emit("data", Buffer.from(char, "utf8"));
}

function options(fixture: ReturnType<typeof fakeTty>): PromptOpenRouterApiKeyOptions {
  return { stdin: fixture.stdin as any, stdout: fixture.stdout as any };
}

test("promptOpenRouterApiKey masks every typed character and returns the trimmed key", async () => {
  const fixture = fakeTty();
  const pending = promptOpenRouterApiKey(options(fixture));
  type(fixture.stdin, "sk-or-v1-abc123\n");
  await expect(pending).resolves.toBe("sk-or-v1-abc123");
  expect(fixture.writes.join("")).not.toContain("sk-or-v1-abc123");
  expect(fixture.writes.filter(chunk => chunk === "*")).toHaveLength("sk-or-v1-abc123".length);
});

test("promptOpenRouterApiKey applies backspace corrections before the key is read", async () => {
  const fixture = fakeTty();
  const pending = promptOpenRouterApiKey(options(fixture));
  type(fixture.stdin, "sk-or-wronggright\n");
  await expect(pending).resolves.toBe("sk-or-wrongright");
});

test("promptOpenRouterApiKey rejects when cancelled with Ctrl+C", async () => {
  const fixture = fakeTty();
  const pending = promptOpenRouterApiKey(options(fixture));
  type(fixture.stdin, "partial");
  await expect(pending).rejects.toThrow(/cancelled/);
});

test("promptOpenRouterApiKey rejects an empty entry", async () => {
  const fixture = fakeTty();
  const pending = promptOpenRouterApiKey(options(fixture));
  type(fixture.stdin, "\n");
  await expect(pending).rejects.toThrow(/non-empty/);
});

test("promptOpenRouterApiKey rejects on a non-interactive terminal, without touching raw mode", async () => {
  const fixture = fakeTty({ stdinIsTTY: false });
  await expect(promptOpenRouterApiKey(options(fixture))).rejects.toThrow(/interactive terminal/);
  expect(fixture.rawModeCalls).toHaveLength(0);
});

test("the OpenRouter path writes the prompted key into .env via the shared upsert helper, leaving other lines untouched", async () => {
  const fixture = fakeTty();
  const pending = promptOpenRouterApiKey(options(fixture));
  type(fixture.stdin, "sk-or-v1-newkey\n");
  const apiKey = await pending;

  const existing = "OPENROUTER_API_KEY=sk-or-v1-oldkey\nJEV_API_TOKEN=unrelated\n";
  const updated = upsertEnvVariable(existing, "OPENROUTER_API_KEY", apiKey);
  expect(updated).toBe("OPENROUTER_API_KEY=sk-or-v1-newkey\nJEV_API_TOKEN=unrelated\n");
});
