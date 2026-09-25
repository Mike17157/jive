import { EventEmitter } from "node:events";
import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAnthropicOauthToken,
  isExecutableOnPath,
  runClaudeSetupToken,
  type RunClaudeSetupTokenOptions,
} from "../src/planner/anthropic-auth";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jive-anthropic-auth-"));
  directories.push(path);
  return path;
}

test("extracts a token printed on its own", () => {
  expect(extractAnthropicOauthToken("Your token: sk-ant-oat01-AbC123_-xyz789QRSTUVWXYZ\nDone.")).toBe("sk-ant-oat01-AbC123_-xyz789QRSTUVWXYZ");
});

test("extracts a token wrapped in ANSI color and cursor-position escape codes", () => {
  const styled = "\x1b[38;2;255;255;255mToken\x1b[39m: \x1b[1msk-ant-oat01-AbC123_-xyz789QRSTUVWXYZ\x1b[22m\x1b[2K\x1b[1A";
  expect(extractAnthropicOauthToken(styled)).toBe("sk-ant-oat01-AbC123_-xyz789QRSTUVWXYZ");
});

test("extracts nothing when no token shape appears, e.g. a cancelled or failed run", () => {
  expect(extractAnthropicOauthToken("OAuth error: Invalid code. Please make sure the full code was copied")).toBeUndefined();
  expect(extractAnthropicOauthToken("")).toBeUndefined();
});

test("isExecutableOnPath finds an executable file on PATH and rejects a non-executable or missing one", async () => {
  const dir = await scratch();
  const executable = join(dir, "claude");
  await writeFile(executable, "#!/bin/sh\necho hi\n");
  await chmod(executable, 0o755);
  expect(await isExecutableOnPath("claude", dir)).toBe(true);
  expect(await isExecutableOnPath("does-not-exist", dir)).toBe(false);

  const notExecutable = join(dir, "not-executable-file");
  await writeFile(notExecutable, "not a script");
  expect(await isExecutableOnPath("not-executable-file", dir)).toBe(false);
});

/** A stand-in for `Bun.spawn`: replays `chunks` through the `terminal.data` callback, then exits. */
function stubSpawn(exitCode: number, chunks: string[]): typeof Bun.spawn {
  const encoder = new TextEncoder();
  const terminal = { write: () => 0, resize: () => {}, close: () => {} } as unknown as Bun.Terminal;
  return ((_command: unknown, spawnOptions: any) => {
    for (const chunk of chunks) spawnOptions.terminal.data(terminal, encoder.encode(chunk));
    return { terminal, exited: Promise.resolve(exitCode) };
  }) as unknown as typeof Bun.spawn;
}

/** A minimal interactive-terminal stand-in for stdin/stdout, since bun test's own are not TTYs. */
function fakeTty() {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() {}, resume() {}, pause() {} });
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: () => true });
  return { stdin, stdout };
}

function options(overrides: Partial<RunClaudeSetupTokenOptions> = {}): RunClaudeSetupTokenOptions {
  const { stdin, stdout } = fakeTty();
  return { commandOnPath: async () => true, stdin, stdout, ...overrides };
}

test("runClaudeSetupToken returns the token printed by a stubbed successful run", async () => {
  const spawn = stubSpawn(0, ["Opening browser to sign in…\n", "Your token: sk-ant-oat01-AbC123_-xyz789QRSTUVWXYZ\n"]);
  const token = await runClaudeSetupToken(options({ spawn }));
  expect(token).toBe("sk-ant-oat01-AbC123_-xyz789QRSTUVWXYZ");
});

test("runClaudeSetupToken fails with a clear message when claude is not on PATH", async () => {
  await expect(runClaudeSetupToken(options({ commandOnPath: async () => false }))).rejects.toThrow(/not on PATH/);
});

test("runClaudeSetupToken fails with a clear message on a non-interactive terminal, without spawning", async () => {
  const { stdin, stdout } = fakeTty();
  let spawnCalled = false;
  const spawn = (() => { spawnCalled = true; throw new Error("should not spawn"); }) as unknown as typeof Bun.spawn;
  await expect(runClaudeSetupToken({ commandOnPath: async () => true, spawn, stdin: { ...stdin, isTTY: false } as any, stdout }))
    .rejects.toThrow(/interactive terminal/);
  expect(spawnCalled).toBe(false);
});

test("runClaudeSetupToken fails with a clear message when the flow is cancelled without printing a token", async () => {
  const spawn = stubSpawn(1, ["OAuth error: Invalid code. Please make sure the full code was copied\n"]);
  await expect(runClaudeSetupToken(options({ spawn }))).rejects.toThrow(/exited with code 1/);
});

test("runClaudeSetupToken fails with a clear message when the process exits cleanly without a token", async () => {
  const spawn = stubSpawn(0, ["Nothing useful here.\n"]);
  await expect(runClaudeSetupToken(options({ spawn }))).rejects.toThrow(/without printing a recognizable token/);
});
