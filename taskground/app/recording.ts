import { createWriteStream, type WriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";

export interface RecordingDimensions {
  width: number;
  height: number;
  columns: number;
  rows: number;
}

export interface RecordingOptions extends RecordingDimensions {}

export interface RecordingCaptureOptions extends RecordingOptions {
  path: string;
}

export type RecordingStream = "stdout" | "stderr";

export interface RecordingEntry {
  type: "entry";
  elapsedMs: number;
  timestamp: string;
  stream: RecordingStream;
  text: string;
}

export interface RecordingHeader extends RecordingDimensions {
  type: "recording";
  version: 1;
  kind: "headless-transcript";
  createdAt: string;
  notice: string;
}

export const HEADLESS_NOTICE = "Rendered headless transcript (stdout/stderr), not a recording of a native interactive TUI.";
const MAX_PENDING_LINE = 2 * 1024 * 1024;
const MAX_RENDERED_TEXT = 32_000;

export function validateRecording(input: unknown): RecordingOptions {
  if (!input || typeof input !== "object") throw new Error("Recording options are required");
  const value = input as Record<string, unknown>;
  const integer = (name: keyof RecordingDimensions, minimum: number, maximum: number, even = false) => {
    const candidate = value[name];
    if (!Number.isInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum || (even && (candidate as number) % 2 !== 0)) {
      throw new Error(`Recording ${name} must be ${even ? "an even " : "an "}integer from ${minimum} to ${maximum}`);
    }
    return candidate as number;
  };
  return {
    width: integer("width", 320, 7680, true), height: integer("height", 240, 4320, true),
    columns: integer("columns", 20, 400), rows: integer("rows", 5, 200),
  };
}

export function normalizeRecordingOptions(input: unknown): RecordingCaptureOptions {
  if (!input || typeof input !== "object") throw new Error("Recording options are required");
  const value = input as Record<string, unknown>;
  if (typeof value.path !== "string" || !value.path.trim()) throw new Error("Recording path must be a non-empty file path");
  return { path: resolve(value.path), ...validateRecording(value) };
}

// CSI, OSC, two-byte ESC sequences, and unsafe C0 controls. Recorded output is
// always treated as text, never replayed into a terminal.
export function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\ud7ff\ue000-\ufffd]/g, "");
}

function limited(value: unknown, limit = MAX_RENDERED_TEXT): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[… ${text.length - limit} characters omitted from transcript; original log is retained …]`;
}

function label(value: unknown, fallback: string): string {
  return limited(typeof value === "string" && value.trim() ? value.trim() : fallback, 500);
}

/** Stateful best-effort conversion of Jive, Codex, and Claude JSON streams. */
export class ReadableOutputParser {
  #buffers: Record<RecordingStream, string> = { stdout: "", stderr: "" };
  #decoders: Record<RecordingStream, StringDecoder> = {
    stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8"),
  };
  #discarding: Record<RecordingStream, boolean> = { stdout: false, stderr: false };
  #seenMessages = new Set<string>();
  #seenEvents = new Set<string>();
  #phase?: string;

  feed(stream: RecordingStream, chunk: Uint8Array | string): string[] {
    let value = typeof chunk === "string" ? chunk : this.#decoders[stream].write(Buffer.from(chunk));
    const output: string[] = [];
    while (value.length) {
      const newline = value.indexOf("\n");
      const part = newline < 0 ? value : value.slice(0, newline + 1);
      value = newline < 0 ? "" : value.slice(newline + 1);
      if (this.#discarding[stream]) {
        if (newline >= 0) this.#discarding[stream] = false;
        continue;
      }
      this.#buffers[stream] += part;
      if (this.#buffers[stream].length > MAX_PENDING_LINE) {
        this.#buffers[stream] = "";
        this.#discarding[stream] = newline < 0;
        output.push(`[output line omitted: exceeded ${MAX_PENDING_LINE} bytes; see original ${stream} log]`);
      } else if (newline >= 0) {
        const line = this.#buffers[stream].replace(/\r?\n$/, "");
        this.#buffers[stream] = "";
        output.push(...this.#line(line));
      }
    }
    return output;
  }

  finish(stream: RecordingStream): string[] {
    const tail = this.#decoders[stream].end();
    const output = tail ? this.feed(stream, tail) : [];
    if (!this.#discarding[stream] && this.#buffers[stream]) output.push(...this.#line(this.#buffers[stream]));
    this.#buffers[stream] = "";
    this.#discarding[stream] = false;
    return output;
  }

  #line(raw: string): string[] {
    const clean = stripTerminalControls(raw).replace(/\r/g, "");
    if (!clean.trim()) return [];
    let value: any;
    try { value = JSON.parse(clean); } catch { return [limited(clean)]; }
    if (!value || typeof value !== "object") return [limited(clean)];
    return this.#json(value, clean).map(item => limited(stripTerminalControls(item))).filter(Boolean);
  }

  #json(value: any, original: string): string[] {
    if (value.type === "agent.snapshot" || value.type === "agent.finished") {
      const output = this.#snapshot(value.snapshot);
      if (value.type === "agent.finished") output.push("Agent finished.");
      return output;
    }
    if (value.type === "execution.event" && value.data?.event) return this.#execution(value.data.event);
    if (typeof value.type === "string" && /^(graph|node|edge|jev|plugin)\./.test(value.type)) return this.#execution(value);

    // Codex JSONL.
    if (value.type === "thread.started") return [`Codex session started${value.thread_id ? ` (${value.thread_id})` : ""}.`];
    if (value.type === "turn.started") return ["Turn started."];
    if (value.type === "turn.completed") return ["Turn completed."];
    if (value.type === "turn.failed") return [`Turn failed: ${label(value.error?.message ?? value.error, "unknown error")}`];
    if (value.type === "error") return [`Error: ${label(value.message ?? value.error, "unknown error")}`];
    if ((value.type === "item.started" || value.type === "item.completed") && value.item) {
      const item = value.item;
      const prefix = value.type === "item.started" ? "Started" : "Finished";
      if (item.type === "agent_message") return value.type === "item.completed" ? [label(item.text ?? item.content, "Agent response")]: [];
      if (item.type === "reasoning") return value.type === "item.completed" && (item.text || item.content) ? [`Reasoning: ${label(item.text ?? item.content, "")}`] : [];
      if (item.type === "command_execution") {
        const command = label(item.command ?? item.command_line, "command");
        return value.type === "item.started" ? [`$ ${command}`] : [`${prefix} command${item.exit_code !== undefined ? ` (exit ${item.exit_code})` : ""}.`];
      }
      if (item.type === "file_change") return [`${prefix} file changes${item.status ? `: ${item.status}` : "."}`];
      if (item.type === "mcp_tool_call" || item.type === "tool_call") return [`${prefix} tool: ${label(item.name ?? item.tool, item.type)}`];
      return [`${prefix} ${label(item.type, "work item")}.`];
    }

    // Claude stream-json.
    if (value.type === "system" && value.subtype === "init") return [`Claude session started${value.session_id ? ` (${value.session_id})` : ""}.`];
    if (value.type === "assistant" && value.message) return this.#claudeContent(value.message.content);
    if (value.type === "result") {
      const output: string[] = [];
      if (typeof value.result === "string" && value.result.trim()) output.push(value.result);
      output.push(value.is_error ? "Claude run failed." : "Claude run completed.");
      return output;
    }

    if (typeof value.message === "string") return [value.message];
    if (typeof value.text === "string") return [value.text];
    return [limited(original)];
  }

  #claudeContent(content: unknown): string[] {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    const output: string[] = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") output.push(block.text);
      else if (block?.type === "tool_use") output.push(`Tool: ${label(block.name, "unknown")}`);
      else if (block?.type === "thinking" && typeof block.thinking === "string") output.push(`Reasoning: ${block.thinking}`);
    }
    return output;
  }

  #snapshot(snapshot: any): string[] {
    if (!snapshot || typeof snapshot !== "object") return [];
    const output: string[] = [];
    if (Array.isArray(snapshot.messages)) for (const message of snapshot.messages) {
      if (!message || message.role === "user") continue;
      const key = typeof message.id === "string" ? message.id : `${message.role}:${message.text}`;
      if (this.#seenMessages.has(key)) continue;
      this.#seenMessages.add(key);
      if (typeof message.text === "string" && message.text.trim()) output.push(`${message.role === "assistant" ? "Assistant" : label(message.role, "Notice")}: ${message.text}`);
    }
    if (Array.isArray(snapshot.events)) for (const event of snapshot.events) output.push(...this.#execution(event));
    if (typeof snapshot.phase === "string" && snapshot.phase !== this.#phase) {
      this.#phase = snapshot.phase;
      if (snapshot.phase !== "idle") output.push(`Phase: ${snapshot.phase}.`);
    }
    if (typeof snapshot.error === "string" && snapshot.error) output.push(`Error: ${snapshot.error}`);
    return output;
  }

  #execution(event: any): string[] {
    if (!event || typeof event !== "object" || typeof event.type !== "string") return [];
    const key = `${event.graphId ?? ""}:${event.sequence ?? ""}:${event.type}:${event.nodeId ?? ""}`;
    if (this.#seenEvents.has(key)) return [];
    this.#seenEvents.add(key);
    const data = event.data && typeof event.data === "object" ? event.data : {};
    const result = data.result && typeof data.result === "object" ? data.result : {};
    const node = label(result.label ?? data.label ?? event.nodeId, "node");
    switch (event.type) {
      case "graph.building": return [`Planning graph: ${label(data.label, "work")}`];
      case "graph.building.finished": return [`Graph plan ${label(data.status, "ready")}.`];
      case "graph.preview": return [`Graph preview: ${label(data.label, data.graph?.label ?? "work")}`];
      case "graph.started": return [`Graph started: ${label(data.label, "work")}`];
      case "graph.finished": return [`Graph finished: ${label(data.status ?? data.report?.status, "done")}.`];
      case "node.created": return [`Queued ${node}.`];
      case "node.started": return [`Started ${node}.`];
      case "node.finished": return [`${label(result.status, "Finished")} ${node}${result.error ? `: ${label(result.error, "error")}` : "."}`];
      case "jev.request": return [`Decision requested: ${node}.`];
      case "jev.response": return [`Decision received: ${node}.`];
      case "plugin.activity": return [`Plugin: ${label(data.message ?? data.name, "activity")}`];
      default: return [];
    }
  }
}

export class HeadlessRecorder {
  readonly options: RecordingCaptureOptions;
  readonly startedAt = Date.now();
  #writer: WriteStream;
  #completed: Promise<void>;
  #failure?: Error;
  #parser = new ReadableOutputParser();
  #ended = false;

  private constructor(options: RecordingCaptureOptions, writer: WriteStream) {
    this.options = options;
    this.#writer = writer;
    writer.on("error", error => { this.#failure ??= error; });
    this.#completed = finished(writer);
    this.#completed.catch(() => {});
  }

  static async create(options: RecordingCaptureOptions): Promise<HeadlessRecorder> {
    const writer = createWriteStream(options.path, { flags: "w", mode: 0o600, encoding: "utf8" });
    await new Promise<void>((resolvePromise, reject) => {
      const opened = () => { cleanup(); resolvePromise(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { writer.off("open", opened); writer.off("error", failed); };
      writer.once("open", opened); writer.once("error", failed);
    });
    const recorder = new HeadlessRecorder(options, writer);
    const header: RecordingHeader = {
      type: "recording", version: 1, kind: "headless-transcript", createdAt: new Date(recorder.startedAt).toISOString(),
      notice: HEADLESS_NOTICE, width: options.width, height: options.height, columns: options.columns, rows: options.rows,
    };
    writer.write(`${JSON.stringify(header)}\n`);
    return recorder;
  }

  write(stream: RecordingStream, chunk: Uint8Array | string, elapsedMs = Date.now() - this.startedAt): boolean {
    if (this.#failure) throw this.#failure;
    let ready = true;
    for (const text of this.#parser.feed(stream, chunk)) ready = this.#entry(stream, text, elapsedMs) && ready;
    return ready;
  }

  async finish(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#failure) { this.#writer.destroy(); await this.#completed; return; }
    const elapsedMs = Date.now() - this.startedAt;
    for (const stream of ["stdout", "stderr"] as const) for (const text of this.#parser.finish(stream)) this.#entry(stream, text, elapsedMs);
    this.#writer.write(`${JSON.stringify({ type: "end", elapsedMs, timestamp: new Date().toISOString() })}\n`);
    this.#writer.end();
    await this.#completed;
  }

  async drain(): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (!this.#writer.writableNeedDrain) return;
    await once(this.#writer, "drain");
    if (this.#failure) throw this.#failure;
  }

  onError(listener: (error: Error) => void): () => void {
    if (this.#failure) { queueMicrotask(() => listener(this.#failure!)); return () => {}; }
    this.#writer.on("error", listener);
    return () => this.#writer.off("error", listener);
  }

  #entry(stream: RecordingStream, text: string, elapsedMs: number): boolean {
    const entry: RecordingEntry = { type: "entry", elapsedMs, timestamp: new Date(this.startedAt + elapsedMs).toISOString(), stream, text };
    return this.#writer.write(`${JSON.stringify(entry)}\n`);
  }
}

// Kept here as a compatibility surface for taskground callers; the
// implementation lives with the other dashboard output helpers.
export { exportRecording } from "./output";
