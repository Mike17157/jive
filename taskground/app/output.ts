import { constants, createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import {
  HEADLESS_NOTICE, ReadableOutputParser, normalizeRecordingOptions, stripTerminalControls,
  validateRecording as validateRecordingMetadata,
  type RecordingDimensions, type RecordingHeader, type RecordingOptions,
} from "./recording";

export type { RecordingDimensions, RecordingOptions } from "./recording";

interface OutputRun {
  directory: string;
  status?: string;
  mode?: string;
  recording?: RecordingDimensions;
}

const OUTPUT_LIMIT = 64 * 1024;
const stoppedStatuses = new Set(["ready", "completed", "failed", "cancelled", "timed_out"]);

export function validateRecording(input: unknown): RecordingOptions {
  return validateRecordingMetadata(input);
}

class BoundedText {
  #value = "";
  omitted = false;
  append(value: string) {
    if (!value) return;
    this.#value += value;
    if (this.#value.length > OUTPUT_LIMIT) {
      this.omitted = true;
      this.#value = this.#value.slice(-OUTPUT_LIMIT);
      const newline = this.#value.indexOf("\n");
      if (newline >= 0) this.#value = this.#value.slice(newline + 1);
    }
  }
  get empty() { return !this.#value; }
  toString() { return `${this.omitted ? "[… earlier transcript omitted …]\n" : ""}${this.#value}`.trimEnd(); }
}

function elapsed(value: number): string {
  const milliseconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}

function parseRecord(line: string, lineNumber: number): any {
  try { return JSON.parse(line); }
  catch { throw new Error(`Recording is invalid JSONL at line ${lineNumber}`); }
}

interface TailState { offset: number; partial: string; decoder: StringDecoder; lineNumber: number }
interface OutputCache {
  output: BoundedText;
  parser: ReadableOutputParser;
  recording: TailState;
  logOffsets: Record<"stdout" | "stderr", number>;
  finishedLogs: Set<string>;
  recordingMode: boolean;
  work: Promise<void>;
  busy: number;
  lastUsed: number;
}

const outputCaches = new Map<string, OutputCache>();

function newCache(): OutputCache {
  return {
    output: new BoundedText(), parser: new ReadableOutputParser(),
    recording: { offset: 0, partial: "", decoder: new StringDecoder("utf8"), lineNumber: 0 },
    logOffsets: { stdout: 0, stderr: 0 }, finishedLogs: new Set(), recordingMode: false,
    work: Promise.resolve(), busy: 0, lastUsed: Date.now(),
  };
}

function cacheFor(directory: string): OutputCache {
  let cache = outputCaches.get(directory);
  if (!cache) {
    cache = newCache(); outputCaches.set(directory, cache);
    if (outputCaches.size > 128) {
      const oldest = [...outputCaches].filter(([path, value]) => path !== directory && value.busy === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) outputCaches.delete(oldest[0]);
    }
  }
  cache.lastUsed = Date.now();
  return cache;
}

async function fileSize(path: string): Promise<number | undefined> {
  try { return (await stat(path)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function chunks(path: string, start: number, end: number, consume: (chunk: Buffer) => void): Promise<void> {
  if (end <= start) return;
  const input = createReadStream(path, { start, end: end - 1 });
  try { for await (const chunk of input) consume(chunk as Buffer); }
  finally { input.destroy(); }
}

function resetForRecording(cache: OutputCache) {
  cache.output = new BoundedText();
  cache.parser = new ReadableOutputParser();
  cache.recording = { offset: 0, partial: "", decoder: new StringDecoder("utf8"), lineNumber: 0 };
  cache.logOffsets = { stdout: 0, stderr: 0 };
  cache.finishedLogs.clear();
  cache.recordingMode = true;
}

async function updateRecording(cache: OutputCache, path: string, size: number): Promise<void> {
  if (size < cache.recording.offset) resetForRecording(cache);
  const state = cache.recording;
  await chunks(path, state.offset, size, chunk => {
    state.offset += chunk.length;
    state.partial += state.decoder.write(chunk);
    let newline: number;
    while ((newline = state.partial.indexOf("\n")) >= 0) {
      const line = state.partial.slice(0, newline).replace(/\r$/, "");
      state.partial = state.partial.slice(newline + 1);
      state.lineNumber += 1;
      if (!line.trim()) continue;
      let record: any;
      try { record = parseRecord(line, state.lineNumber); } catch { continue; }
      if (record.type === "entry" && typeof record.text === "string") {
        cache.output.append(`[+${elapsed(Number(record.elapsedMs) || 0)}]${record.stream === "stderr" ? " [stderr]" : ""} ${stripTerminalControls(record.text)}\n`);
      }
    }
    if (state.partial.length > 2 * 1024 * 1024) state.partial = state.partial.slice(-2 * 1024 * 1024);
  });
}

async function updateLog(cache: OutputCache, path: string, stream: "stdout" | "stderr", stopped: boolean): Promise<void> {
  const size = await fileSize(path);
  if (size === undefined) return;
  if (size < cache.logOffsets[stream]) {
    cache.output = new BoundedText(); cache.parser = new ReadableOutputParser();
    cache.logOffsets = { stdout: 0, stderr: 0 }; cache.finishedLogs.clear();
  }
  await chunks(path, cache.logOffsets[stream], size, chunk => {
    cache.logOffsets[stream] += chunk.length;
    for (const text of cache.parser.feed(stream, chunk)) cache.output.append(`${stream === "stderr" ? "[stderr] " : ""}${text}\n`);
  });
  if (stopped && !cache.finishedLogs.has(stream)) {
    cache.finishedLogs.add(stream);
    for (const text of cache.parser.finish(stream)) cache.output.append(`${stream === "stderr" ? "[stderr] " : ""}${text}\n`);
  }
}

async function updateOutput(cache: OutputCache, run: OutputRun, directory: string): Promise<void> {
  const recordingPath = join(directory, "recording.jsonl");
  const recordingSize = await fileSize(recordingPath);
  if (recordingSize !== undefined) {
    if (!cache.recordingMode) resetForRecording(cache);
    await updateRecording(cache, recordingPath, recordingSize);
    return;
  }
  const stopped = Boolean(run.status && stoppedStatuses.has(run.status));
  await updateLog(cache, join(directory, "logs/agent.stdout.log"), "stdout", stopped);
  await updateLog(cache, join(directory, "logs/agent.stderr.log"), "stderr", stopped);
}

/** Human-readable, bounded output for a dashboard. */
export async function readRunOutput(run: OutputRun): Promise<string> {
  if (run.mode === "terminal") return "This run uses the agent's native interface. Open the Terminal tab to view its screen or attach. Raw terminal output is retained in logs/terminal.log.";
  const directory = resolve(run.directory);
  const cache = cacheFor(directory);
  cache.busy += 1;
  const update = cache.work.then(() => updateOutput(cache, run, directory));
  cache.work = update.catch(() => {});
  try { await update; } finally { cache.busy -= 1; }
  const body = cache.output.empty ? "No captured headless output yet." : cache.output.toString();
  return `${HEADLESS_NOTICE}\n${run.status ? `Status: ${run.status}\n` : ""}\n${body}`.trimEnd();
}

function wrapLine(value: string, columns: number): string[] {
  const expanded = stripTerminalControls(value).replace(/\t/g, "    ").replace(/\r/g, "");
  const source = [...expanded];
  if (!source.length) return [""];
  const lines: string[] = [];
  for (let index = 0; index < source.length; index += columns) lines.push(source.slice(index, index + columns).join(""));
  return lines;
}

function assTime(milliseconds: number): string {
  const centiseconds = Math.max(0, Math.floor(milliseconds / 10));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor(centiseconds / 6_000) % 60;
  const seconds = Math.floor(centiseconds / 100) % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}

function assText(lines: string[]): string {
  return lines.join("\n").replace(/\\/g, "\\\\").replace(/{/g, "｛").replace(/}/g, "｝").replace(/\n/g, "\\N");
}

function terminalGeometry(options: RecordingDimensions) {
  const margin = Math.max(2, Math.floor(options.width / options.columns / 2));
  const rowHeight = options.height / (options.rows + 1);
  const byHeight = rowHeight * .72;
  const byWidth = (options.width - margin * 2) / (options.columns * .65);
  return { margin, rowHeight, fontSize: Math.max(1, Math.floor(Math.min(byHeight, byWidth))) };
}

function assHeader(options: RecordingDimensions): string {
  const { fontSize, margin } = terminalGeometry(options);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${options.width}
PlayResY: ${options.height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Terminal,Menlo,${fontSize},&H00E8EDF2,&H00E8EDF2,&H00000000,&H0010141A,0,0,0,0,100,100,0,0,1,0,0,7,${margin},${margin},${margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

async function walkTranscript(
  recordingPath: string,
  expected: RecordingDimensions,
  interval: (start: number, end: number, screen: readonly string[]) => Promise<void>,
): Promise<number> {
  const screen = [HEADLESS_NOTICE, ""];
  let lineNumber = 0, stateStart = 0, endMs = 0, header: RecordingHeader | undefined, entries = 0;
  const input = createReadStream(recordingPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      const record = parseRecord(line, lineNumber);
      if (record.type === "recording") {
        header = record;
        continue;
      }
      if (record.type === "end") {
        endMs = Math.max(endMs, Number(record.elapsedMs) || 0);
        continue;
      }
      if (record.type !== "entry" || typeof record.text !== "string") continue;
      const at = Math.max(stateStart, Number(record.elapsedMs) || 0);
      if (at > stateStart) await interval(stateStart, at, screen.slice(-expected.rows));
      const prefix = `[${elapsed(at)}]${record.stream === "stderr" ? " !" : ""} `;
      const rawLines = stripTerminalControls(record.text).split("\n");
      for (let index = 0; index < rawLines.length; index += 1) {
        const linePrefix = index === 0 ? prefix : " ".repeat(Math.min(prefix.length, expected.columns));
        screen.push(...wrapLine(linePrefix + rawLines[index], expected.columns));
      }
      if (screen.length > expected.rows * 2) screen.splice(0, screen.length - expected.rows);
      stateStart = at;
      endMs = Math.max(endMs, at);
      entries += 1;
    }
    if (!header || header.version !== 1 || header.kind !== "headless-transcript") throw new Error("Recording header is missing or unsupported");
    for (const key of ["width", "height", "columns", "rows"] as const) if (header[key] !== expected[key]) throw new Error(`Recording ${key} does not match run metadata`);
    if (!entries) screen.push("No output was captured.");
    endMs = Math.max(endMs, stateStart + 100);
    await interval(stateStart, endMs, screen.slice(-expected.rows));
  } finally {
    lines.close(); input.destroy();
  }
  return endMs;
}

async function buildSubtitles(recordingPath: string, subtitlePath: string, expected: RecordingDimensions): Promise<number> {
  const output = await open(subtitlePath, "w", 0o600);
  await output.write(assHeader(expected));
  try {
    return await walkTranscript(recordingPath, expected, async (start, end, screen) => {
      await output.write(`Dialogue: 0,${assTime(start)},${assTime(end)},Terminal,,0,0,0,,${assText([...screen])}\n`);
    });
  } finally { await output.close(); }
}

async function runCommand(executable: string, args: string[], cwd: string, name: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { if (diagnostic.length < 64_000) diagnostic += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolvePromise() : reject(new Error(`${name} could not export the headless transcript (exit ${code}): ${diagnostic.trim().slice(-4000)}`)));
  });
}

async function commandOutput(executable: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolvePromise(output + error) : reject(new Error(`Could not inspect FFmpeg capabilities (exit ${code})`)));
  });
}

async function findExecutable(name: string, fallbacks: string[]): Promise<string | undefined> {
  const fromPath = Bun.which(name);
  if (fromPath) return fromPath;
  for (const path of fallbacks) if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  return undefined;
}

interface LockOwner { pid: number; identity: string | null; nonce: string; createdAt: string }
interface LockLease { path: string; owner: LockOwner }

async function processIdentity(pid: number): Promise<string | null> {
  return await new Promise(resolvePromise => {
    const child = spawn("ps", ["-p", String(pid), "-o", "lstart="], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { if (output.length < 1024) output += chunk; });
    child.once("error", () => resolvePromise(null));
    child.once("close", code => resolvePromise(code === 0 && output.trim() ? output.trim() : null));
  });
}

async function createLock(path: string): Promise<LockLease> {
  const owner: LockOwner = { pid: process.pid, identity: await processIdentity(process.pid), nonce: randomUUID(), createdAt: new Date().toISOString() };
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(owner)}\n`); }
  catch (error) { await file.close().catch(() => {}); await unlink(path).catch(() => {}); throw error; }
  await file.close();
  return { path, owner };
}

async function readLock(path: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && Number.isInteger(value.pid) && typeof value.nonce === "string" ? value as LockOwner : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function lockIsLive(path: string): Promise<boolean> {
  const owner = await readLock(path);
  if (!owner) {
    try { await stat(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  if (!owner.identity) return true;
  const identity = await processIdentity(owner.pid);
  return identity === null || identity === owner.identity;
}

async function releaseLock(lease: LockLease): Promise<void> {
  const current = await readLock(lease.path);
  if (current?.nonce === lease.owner.nonce) await unlink(lease.path).catch(() => {});
}

async function acquireExportLock(path: string): Promise<LockLease> {
  try { return await createLock(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (await lockIsLive(path)) throw new Error("A recording export is already in progress for this run");

  // Serialize stale-lock recovery so two callers cannot unlink a newly-created
  // live lock between inspection and acquisition.
  const recoveryPath = `${path}.recovery`;
  let recovery: LockLease;
  try { recovery = await createLock(recoveryPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A recording export lock is being recovered; retry shortly");
    throw error;
  }
  try {
    if (await lockIsLive(path)) throw new Error("A recording export is already in progress for this run");
    await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    return await createLock(path);
  } finally { await releaseLock(recovery); }
}

async function buildFrameConcat(
  recordingPath: string,
  directory: string,
  expected: RecordingDimensions,
  renderer: string,
  font: string,
): Promise<{ durationMs: number; concatPath: string }> {
  const frames = join(directory, "frames");
  await mkdir(frames);
  const concatPath = join(directory, "timeline.txt");
  const timeline = await open(concatPath, "w", 0o600);
  let index = 0, last = "";
  try {
    const durationMs = await walkTranscript(recordingPath, expected, async (start, end, screen) => {
      const base = `frame-${String(index++).padStart(7, "0")}`;
      const pngPath = join(frames, `${base}.png`);
      const { rowHeight, fontSize, margin: left } = terminalGeometry(expected);
      await runCommand(renderer, [
        "-size", `${expected.width}x${expected.height}`, "xc:#10141a",
        "-font", font, "-pointsize", String(fontSize), "-fill", "#e8edf2", "-gravity", "NorthWest",
        "-interline-spacing", String(Math.max(0, Math.floor(rowHeight - fontSize))),
        "-annotate", `+${left}+${Math.max(4, Math.floor(rowHeight / 4))}`, screen.join("\n"), pngPath,
      ], directory, "Local image renderer");
      await timeline.write(`file 'frames/${base}.png'\nduration ${((end - start) / 1000).toFixed(3)}\n`);
      last = `frames/${base}.png`;
    });
    if (last) await timeline.write(`file '${last}'\n`);
    return { durationMs, concatPath };
  } finally { await timeline.close(); }
}

/** Export the stopped run's timestamped headless transcript to an MP4. */
export async function exportRecording(run: OutputRun): Promise<string> {
  if (run.mode === "interactive") throw new Error("Interactive TTY runs cannot be exported as headless transcript recordings");
  if (!run.status || !stoppedStatuses.has(run.status)) throw new Error(`Run is ${run.status ?? "active"}; stop it before exporting its recording`);
  if (!run.recording) throw new Error("This run has no recording metadata; enable headless recording when starting it");
  const directory = resolve(run.directory);
  const recordingPath = join(directory, "recording.jsonl");
  const options = normalizeRecordingOptions({ path: recordingPath, ...run.recording });
  const finalPath = join(directory, "recording.mp4");
  if (await access(finalPath).then(() => true, () => false)) return finalPath;
  await access(recordingPath).catch(() => { throw new Error(`Headless transcript is missing: ${recordingPath}`); });
  const ffmpeg = await findExecutable("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
  if (!ffmpeg) throw new Error("Recording export requires FFmpeg on PATH (or at a standard Homebrew/system location)");

  const lockPath = join(directory, "recording-export.lock");
  const lock = await acquireExportLock(lockPath);
  if (await access(finalPath).then(() => true, () => false)) {
    await releaseLock(lock);
    return finalPath;
  }
  const temporaryVideo = join(directory, `.recording-${randomUUID()}.mp4`);
  let temporaryDirectory: string | undefined;
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "jive-recording-"));
    const subtitlePath = join(temporaryDirectory, "transcript.ass");
    const filters = await commandOutput(ffmpeg, ["-hide_banner", "-filters"]);
    let durationMs: number;
    if (/\b(?:ass|subtitles)\s+V->V\b/.test(filters)) {
      durationMs = await buildSubtitles(recordingPath, subtitlePath, options);
      const duration = (durationMs / 1000).toFixed(3);
      await runCommand(ffmpeg, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `color=c=0x10141a:s=${options.width}x${options.height}:r=30:d=${duration}`,
        "-vf", "ass=transcript.ass", "-t", duration,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        temporaryVideo,
      ], temporaryDirectory, "FFmpeg");
    } else {
      const renderer = await findExecutable("magick", ["/opt/homebrew/bin/magick", "/usr/local/bin/magick", "/usr/bin/magick"])
        ?? await findExecutable("convert", ["/opt/homebrew/bin/convert", "/usr/local/bin/convert", "/usr/bin/convert"]);
      if (!renderer) throw new Error("This FFmpeg build has no ASS/subtitles filter, and no local ImageMagick renderer was found; install FFmpeg with libass or ImageMagick to export recordings");
      const fontCandidates = ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"];
      const font = (await Promise.all(fontCandidates.map(async path => await access(path).then(() => path, () => undefined)))).find(Boolean);
      if (!font) throw new Error("The local image renderer needs a monospace font (Menlo, Monaco, or DejaVu Sans Mono) to export recordings");
      const frames = await buildFrameConcat(recordingPath, temporaryDirectory, options, renderer, font);
      durationMs = frames.durationMs;
      const duration = (durationMs / 1000).toFixed(3);
      await runCommand(ffmpeg, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "1", "-i", "timeline.txt", "-t", duration,
        "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        temporaryVideo,
      ], temporaryDirectory, "FFmpeg");
    }
    const result = await stat(temporaryVideo);
    if (!result.isFile() || result.size === 0) throw new Error("FFmpeg produced an empty recording export");
    await rename(temporaryVideo, finalPath);
    return finalPath;
  } finally {
    await unlink(temporaryVideo).catch(() => {});
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    await releaseLock(lock);
  }
}
