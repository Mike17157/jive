import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTerminalEndpoint, runTerminalProcess } from "../taskground/app/terminal";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jive-terminal-test-"));
  temporary.push(directory);
  return directory;
}

async function eventually<T>(read: () => Promise<T | null | undefined>, timeout = 4_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for condition");
}

class TerminalClient {
  readonly socket: WebSocket;
  readonly messages: Array<Record<string, unknown>> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", event => {
      this.messages.push(JSON.parse(String(event.data)));
    });
  }

  static async connect(directory: string): Promise<TerminalClient> {
    const endpoint = await eventually(() => readTerminalEndpoint(directory));
    const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/`, ["taskground", endpoint.token]);
    const client = new TerminalClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
    });
    return client;
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  async next(predicate: (message: Record<string, unknown>) => boolean, timeout = 4_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeout;
    do {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0]!;
      await Bun.sleep(10);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for WebSocket message; received ${JSON.stringify(this.messages)}`);
  }

  close(): void {
    this.socket.close();
  }
}

test("native PTY supports control arbitration, input, resize, reconnect, and final screen persistence", async () => {
  const directory = await scratch();
  const script = String.raw`
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("TTY=" + process.stdin.isTTY + "/" + process.stdout.isTTY + "\r\n\x1b[31mANSI-RED\x1b[0m\r\n");
process.stdout.write(Buffer.from([0xe2]));
setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac, 0x0d, 0x0a])), 25);
process.on("SIGWINCH", () => process.stdout.write("SIZE=" + process.stdout.columns + "x" + process.stdout.rows + "\r\n"));
process.stdin.on("data", chunk => {
  const text = chunk.toString();
  if (text.includes("q")) process.exit(0);
  process.stdout.write("INPUT:" + text + "\r\n");
});
setInterval(() => {}, 1000);
`;
  const running = runTerminalProcess([process.execPath, "-e", script], { cwd: directory, directory, columns: 80, rows: 24 });
  const first = await TerminalClient.connect(directory);
  expect((await stat(join(directory, "terminal.json"))).mode & 0o777).toBe(0o600);
  const initial = await first.next(message => message.type === "snapshot");
  expect(initial).toMatchObject({ type: "snapshot", cols: 80, rows: 24 });
  if (!String(initial.data).includes("TTY=true/true")) {
    await first.next(message => message.type === "output" && String(message.data).includes("TTY=true/true"));
  }
  if (!String(initial.data).includes("€")) {
    await first.next(message => message.type === "output" && String(message.data).includes("€"));
  }

  first.send({ type: "input", data: "blocked" });
  expect(await first.next(message => message.type === "error")).toMatchObject({ message: "Attach before sending terminal input" });
  first.send({ type: "attach" });
  expect(await first.next(message => message.type === "control" && message.attached === true)).toMatchObject({ available: true });

  const second = await TerminalClient.connect(directory);
  expect(await second.next(message => message.type === "control")).toMatchObject({ attached: false, available: false });
  second.send({ type: "attach" });
  expect(String((await second.next(message => message.type === "error")).message)).toContain("already attached");

  first.send({ type: "input", data: "reconnect-marker" });
  await first.next(message => message.type === "output" && String(message.data).includes("INPUT:reconnect-marker"));
  first.send({ type: "resize", cols: 100, rows: 30 });
  expect(await first.next(message => message.type === "snapshot" && message.cols === 100)).toMatchObject({ rows: 30 });
  await first.next(message => message.type === "output" && String(message.data).includes("SIZE=100x30"));
  expect(await eventually(async () => {
    const endpoint = await readTerminalEndpoint(directory);
    return endpoint?.columns === 100 && endpoint.rows === 30 ? endpoint : null;
  })).toMatchObject({ columns: 100, rows: 30 });

  first.send({ type: "detach" });
  expect(await second.next(message => message.type === "control" && message.available === true)).toMatchObject({ attached: false });
  second.send({ type: "attach" });
  await second.next(message => message.type === "control" && message.attached === true);
  first.close();
  await Bun.sleep(50);

  const reconnected = await TerminalClient.connect(directory);
  const retained = await reconnected.next(message => message.type === "snapshot");
  expect(String(retained.data)).toContain("reconnect-marker");
  expect(retained).toMatchObject({ cols: 100, rows: 30 });

  second.send({ type: "input", data: "q" });
  expect(await second.next(message => message.type === "exit")).toMatchObject({ exitCode: 0 });
  const result = await running;
  expect(result).toEqual({ exitCode: 0, signal: null, cancelled: false, timedOut: false });
  const saved = JSON.parse(await readFile(join(directory, "terminal-screen.json"), "utf8"));
  expect(saved).toMatchObject({ cols: 100, rows: 30 });
  expect(saved.data).toContain("reconnect-marker");
  expect(saved.data).toContain("€");
  expect(saved.data).not.toContain("INPUT:blocked");
  expect(saved.data).not.toContain("�");
  const log = await readFile(join(directory, "logs/terminal.log"), "utf8");
  expect(log).toContain("TTY=true/true");
  expect(log).toContain("\x1b[31mANSI-RED\x1b[0m");
  expect(await readTerminalEndpoint(directory)).toBeNull();
  second.close();
  reconnected.close();
});

test("cancel file stops the PTY child and its detached descendant", async () => {
  const directory = await scratch();
  const cancelFile = join(directory, "cancel.requested");
  const descendantFile = join(directory, "descendant.pid");
  const script = String.raw`
const { writeFileSync } = require("node:fs");
const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
  detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore"
});
writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));
setInterval(() => {}, 1000);
`;
  let parentPid = 0;
  const running = runTerminalProcess([process.execPath, "-e", script], {
    cwd: directory,
    directory,
    cancelFile,
    onStart: async pid => { parentPid = pid; },
  });
  const descendantPid = await eventually(async () => {
    try { return Number(await readFile(descendantFile, "utf8")); } catch { return null; }
  });
  await writeFile(cancelFile, "cancel\n");
  const result = await running;
  expect(result.cancelled).toBe(true);
  expect(result.timedOut).toBe(false);
  await eventually(async () => {
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    return !alive(parentPid) && !alive(descendantPid) ? true : null;
  });
  expect(await access(join(directory, "terminal-screen.json")).then(() => true, () => false)).toBe(true);
});

test("pre-cancel and timeout have process-runner semantics", async () => {
  const cancelledDirectory = await scratch();
  const cancelFile = join(cancelledDirectory, "cancel.requested");
  await writeFile(cancelFile, "cancel\n");
  expect(await runTerminalProcess([process.execPath, "-e", "process.exit(99)"], {
    cwd: cancelledDirectory, directory: cancelledDirectory, cancelFile,
  })).toEqual({ exitCode: null, signal: null, cancelled: true, timedOut: false });
  expect(await readTerminalEndpoint(cancelledDirectory)).toBeNull();

  const timeoutDirectory = await scratch();
  const timed = await runTerminalProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    cwd: timeoutDirectory, directory: timeoutDirectory, timeoutMs: 80,
  });
  expect(timed.timedOut).toBe(true);
  expect(timed.cancelled).toBe(false);
});

test("spawn and onStart failures close the supervisor and clean up the child", async () => {
  const spawnDirectory = await scratch();
  await expect(runTerminalProcess(["/definitely/not/a/taskground-command"], {
    cwd: spawnDirectory, directory: spawnDirectory,
  })).rejects.toThrow();
  expect(await readTerminalEndpoint(spawnDirectory)).toBeNull();
  expect(await access(join(spawnDirectory, "terminal-screen.json")).then(() => true, () => false)).toBe(true);

  const startDirectory = await scratch();
  let pid = 0;
  await expect(runTerminalProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    cwd: startDirectory,
    directory: startDirectory,
    onStart: async childPid => { pid = childPid; throw new Error("could not register terminal child"); },
  })).rejects.toThrow("could not register terminal child");
  expect(pid).toBeGreaterThan(0);
  await eventually(async () => {
    try { process.kill(pid, 0); return null; } catch { return true; }
  });
  expect(await readTerminalEndpoint(startDirectory)).toBeNull();
});

test("native terminal answers queries without a viewer and preserves the last alternate screen on exit", async () => {
  const directory = await scratch();
  const script = String.raw`
process.stdin.setRawMode(true);
process.stdin.on('data', data => {
  if (data.toString().includes('R')) {
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[HCompleted native task\x1b[?1049l');
    setTimeout(() => process.exit(0), 20);
  }
});
process.stdout.write('\x1b[6n');
setInterval(() => {}, 1000);
`;
  const result = await runTerminalProcess([process.execPath, "-e", script], { cwd: directory, directory, timeoutMs: 2000 });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
  const saved = JSON.parse(await readFile(join(directory, "terminal-screen.json"), "utf8"));
  expect(saved.data).toContain("Completed native task");
  expect(saved.data).toContain("\x1b[?1049h");
});
