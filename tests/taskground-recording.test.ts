import { afterEach, expect, test } from "bun:test";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, runProcess } from "../taskground/app/process";
import { exportRecording, readRunOutput, validateRecording } from "../taskground/app/output";

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "jive-recording-test-"));
  temporary.push(directory);
  await mkdir(join(directory, "logs"));
  return directory;
}

test("recording validation requires bounded even video dimensions and terminal geometry", () => {
  expect(validateRecording({ width: 1280, height: 720, columns: 120, rows: 36 })).toEqual({ width: 1280, height: 720, columns: 120, rows: 36 });
  expect(() => validateRecording({ width: 1279, height: 720, columns: 120, rows: 36 })).toThrow("even");
  expect(() => validateRecording({ width: 1280, height: 720, columns: 4, rows: 36 })).toThrow("columns");
});

test("headless process tee retains raw logs and records readable, timed, chunk-safe output", async () => {
  const directory = await scratch();
  const stdout = join(directory, "logs/agent.stdout.log"), stderr = join(directory, "logs/agent.stderr.log");
  const recording = join(directory, "recording.jsonl");
  const script = `
process.stdout.write('{"type":"agent.snapshot","snapshot":{"messages":[');
setTimeout(() => {
  process.stdout.write('{"id":"a1","role":"assistant","text":"Human answer"}],"events":[{"graphId":"g","sequence":1,"type":"node.started","nodeId":"inspect","data":{"label":"Inspect files"}}],"phase":"executing"}}\\n');
  process.stderr.write('\\u001b[31mwarning from stderr\\u001b[0m\\n');
  console.log('geometry=' + process.env.COLUMNS + 'x' + process.env.LINES);
}, 70);
setTimeout(() => process.exit(0), 150);
`;
  const result = await runProcess([process.execPath, "-e", script], {
    cwd: directory, stdout, stderr,
    recording: { path: recording, width: 640, height: 360, columns: 80, rows: 24 },
  });
  expect(result.exitCode).toBe(0);
  const raw = await readFile(stdout, "utf8");
  expect(raw).toContain('"type":"agent.snapshot"');
  expect(raw).toContain("geometry=80x24");
  expect(await readFile(stderr, "utf8")).toContain("\u001b[31mwarning");

  const records = (await readFile(recording, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(records[0]).toMatchObject({ type: "recording", kind: "headless-transcript", width: 640, height: 360 });
  const entries = records.filter(record => record.type === "entry");
  expect(entries.map(entry => entry.text).join("\n")).toContain("Assistant: Human answer");
  expect(entries.map(entry => entry.text).join("\n")).toContain("Started Inspect files");
  expect(entries.map(entry => entry.text).join("\n")).toContain("warning from stderr");
  expect(entries.map(entry => entry.text).join("\n")).not.toContain("agent.snapshot");
  expect(records.at(-1).elapsedMs).toBeGreaterThanOrEqual(100);
  const dashboard = await readRunOutput({ directory, status: "completed", recording: { width: 640, height: 360, columns: 80, rows: 24 } });
  expect(dashboard).toContain("not a recording of a native interactive TUI");
  expect(dashboard).toContain("Human answer");
  expect(dashboard).not.toContain("\u001b[31m");
});

test("dashboard output tails incrementally, serializes concurrent reads, and retains partial lines", async () => {
  const directory = await scratch();
  const options = { width: 640, height: 360, columns: 80, rows: 24 };
  const recording = join(directory, "recording.jsonl");
  const header = JSON.stringify({ type: "recording", version: 1, kind: "headless-transcript", createdAt: new Date().toISOString(), notice: "test", ...options });
  const first = JSON.stringify({ type: "entry", elapsedMs: 1, timestamp: new Date().toISOString(), stream: "stdout", text: "first" });
  const second = JSON.stringify({ type: "entry", elapsedMs: 2, timestamp: new Date().toISOString(), stream: "stdout", text: "second" });
  await writeFile(recording, `${header}\n${first}\n${second.slice(0, 30)}`);
  const run = { directory, mode: "headless", status: "running", recording: options };
  expect(await readRunOutput(run)).toContain("first");
  expect(await readRunOutput(run)).not.toContain("second");
  await appendFile(recording, `${second.slice(30)}\n`);
  const concurrent = await Promise.all([readRunOutput(run), readRunOutput(run), readRunOutput(run)]);
  for (const text of concurrent) {
    expect(text.match(/second/g)).toHaveLength(1);
    expect(text.match(/first/g)).toHaveLength(1);
  }
});

test("dashboard fallback parser retains an unfinished giant-snapshot line between polls", async () => {
  const directory = await scratch();
  const stdout = join(directory, "logs/agent.stdout.log");
  const prefix = '{"type":"agent.snapshot","snapshot":{"messages":[{"id":"cached","role":"assistant","text":"cached answer"}],';
  await writeFile(stdout, prefix);
  const run = { directory, mode: "headless", status: "running" };
  expect(await readRunOutput(run)).toContain("No captured headless output yet");
  await appendFile(stdout, '"events":[],"phase":"idle"}}\n');
  const [left, right] = await Promise.all([readRunOutput(run), readRunOutput(run)]);
  expect(left.match(/cached answer/g)).toHaveLength(1);
  expect(right).toBe(left);
});

test("recorder setup failure closes log streams and never starts the child", async () => {
  const directory = await scratch();
  const marker = join(directory, "started");
  await expect(runProcess([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`], {
    cwd: directory,
    stdout: join(directory, "logs/agent.stdout.log"), stderr: join(directory, "logs/agent.stderr.log"),
    recording: { path: join(directory, "missing/recording.jsonl"), width: 640, height: 360, columns: 80, rows: 24 },
  })).rejects.toThrow();
  expect(await access(marker).then(() => true, () => false)).toBe(false);
  await appendFile(join(directory, "logs/agent.stdout.log"), "still writable\n");
});

test("recording export is atomic and has the requested dimensions when local tools are available", async () => {
  const ffmpeg = "/opt/homebrew/bin/ffmpeg", ffprobe = "/opt/homebrew/bin/ffprobe";
  if (!await access(ffmpeg).then(() => true, () => false)) return;
  const directory = await scratch();
  const options = { width: 640, height: 360, columns: 80, rows: 24 };
  const createdAt = new Date().toISOString();
  await writeFile(join(directory, "recording.jsonl"), [
    { type: "recording", version: 1, kind: "headless-transcript", createdAt, notice: "test", ...options },
    { type: "entry", elapsedMs: 0, timestamp: createdAt, stream: "stdout", text: "Starting work" },
    { type: "entry", elapsedMs: 180, timestamp: createdAt, stream: "stdout", text: "Work complete" },
    { type: "end", elapsedMs: 320, timestamp: createdAt },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  await writeFile(join(directory, "recording-export.lock"), JSON.stringify({ pid: 2_147_483_647, identity: "old process", nonce: "stale", createdAt: new Date(0).toISOString() }));
  const path = await exportRecording({ directory, mode: "headless", status: "completed", recording: options });
  expect(path).toBe(join(directory, "recording.mp4"));
  expect(await exportRecording({ directory, mode: "headless", status: "completed", recording: options })).toBe(path);
  if (await access(ffprobe).then(() => true, () => false)) {
    const dimensions = await capture([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path], directory);
    expect(dimensions).toBe("640x360");
  }
  expect(await access(join(directory, "recording-export.lock")).then(() => true, () => false)).toBe(false);
});

test("recording export never removes a lock owned by a live process", async () => {
  if (!await access("/opt/homebrew/bin/ffmpeg").then(() => true, () => false) && !Bun.which("ffmpeg")) return;
  const directory = await scratch();
  const options = { width: 640, height: 360, columns: 80, rows: 24 };
  await writeFile(join(directory, "recording.jsonl"), `${JSON.stringify({ type: "recording", version: 1, kind: "headless-transcript", createdAt: new Date().toISOString(), notice: "test", ...options })}\n`);
  const lock = { pid: process.pid, identity: null, nonce: "live-owner", createdAt: new Date().toISOString() };
  const lockPath = join(directory, "recording-export.lock");
  await writeFile(lockPath, JSON.stringify(lock));
  await expect(exportRecording({ directory, mode: "headless", status: "completed", recording: options })).rejects.toThrow("already in progress");
  expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(lock);
});
