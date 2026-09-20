import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, truncate, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { excerptOversizedOutput } from "./excerpts";
import { fallbackSessionName, normalizeSessionName } from "./names.ts";
import type { ExecutionEvent, NodeResult } from "../core/types";
import type { ProjectSkillsSnapshot } from "../core/project-skills.ts";

import type {
  ArchiveMatch,
  MessageEventData,
  PlannerMessage,
  ProjectInstructionsEventData,
  SessionArtifact,
  SessionEvent,
  SessionEventType,
  SessionNameEventData,
  SessionSummary,
} from "./types.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SessionStoreOptions {
  cwd: string;
  sessionId?: string;
  baseDirectory?: string;
  /** Refuse to create a missing log. Used by resume paths. */
  existingOnly?: boolean;
}

export interface AppendSessionEvent {
  type: SessionEventType;
  data?: Record<string, unknown>;
}

export interface InterruptedToolCall {
  callId: string;
  graphId: string;
  graph: unknown;
  started: boolean;
}

export interface RecoverToolCallsOptions {
  status?: "interrupted" | "cancelled";
  reason?: string;
}

export function createSessionId(): string {
  return randomUUID();
}

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      "Invalid session ID. Use 1-128 letters, numbers, dots, underscores, or hyphens.",
    );
  }
}

export function sessionDirectory(cwd: string, sessionId: string): string {
  assertSessionId(sessionId);
  return join(resolve(cwd), ".jev", "sessions", sessionId);
}

export function sessionsDirectory(cwd: string): string {
  return join(resolve(cwd), ".jev", "sessions");
}

function jsonLine(event: SessionEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function safeArtifactName(name: string): string {
  const safe = basename(name)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return safe || "artifact";
}

/** Append-only JSONL persistence for one agent session. */
export class SessionStore {
  readonly cwd: string;
  readonly sessionId: string;
  readonly directory: string;
  readonly logPath: string;
  readonly artifactsDirectory: string;
  readonly existingOnly: boolean;

  #events: SessionEvent[] = [];
  #ready = false;
  #initializing?: Promise<void>;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: SessionStoreOptions) {
    this.cwd = resolve(options.cwd);
    this.sessionId = options.sessionId ?? createSessionId();
    assertSessionId(this.sessionId);
    this.directory = options.baseDirectory
      ? join(resolve(options.baseDirectory), this.sessionId)
      : sessionDirectory(this.cwd, this.sessionId);
    this.logPath = join(this.directory, "session.jsonl");
    this.artifactsDirectory = join(this.directory, "artifacts");
    this.existingOnly = options.existingOnly ?? false;
  }

  async initialize(): Promise<void> {
    if (this.#ready) return;
    if (!this.#initializing) {
      this.#initializing = this.#initializeOnce().finally(() => {
        this.#initializing = undefined;
      });
    }
    await this.#initializing;
  }

  get events(): readonly SessionEvent[] {
    return this.#events;
  }

  async reload(): Promise<readonly SessionEvent[]> {
    await this.initialize();
    await this.flush();
    this.#events = await this.#readLog();
    return this.events;
  }

  async append<T extends Record<string, unknown>>(
    type: SessionEventType,
    data: T,
  ): Promise<SessionEvent<T>> {
    if (!this.#ready) await this.initialize();

    const operation = this.#tail.then(() => this.#appendNow(type, data));
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async #appendNow<T extends Record<string, unknown>>(
    type: SessionEventType,
    data: T,
  ): Promise<SessionEvent<T>> {
    const event: SessionEvent<T> = {
      id: randomUUID(),
      sequence: (this.#events.at(-1)?.sequence ?? 0) + 1,
      timestamp: new Date().toISOString(),
      type,
      data,
    };
    await appendFile(this.logPath, jsonLine(event), { encoding: "utf8", flag: "a" });
    this.#events.push(event as SessionEvent);
    return event;
  }

  appendMessage(
    message: PlannerMessage,
    chatId?: string,
    metadata: Omit<MessageEventData, "message" | "chatId"> = {},
  ): Promise<SessionEvent<MessageEventData>> {
    return this.append("planner.message", {
      message,
      ...(chatId ? { chatId } : {}),
      ...metadata,
    });
  }

  async addPin(text: string): Promise<void> {
    await this.append("pin.added", { text });
    await this.appendMessage({
      role: "system",
      content: `Pinned constraint (verbatim):\n${text}`,
    });
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  plannerMessageEvents(): Array<SessionEvent<MessageEventData>> {
    return this.#events.filter(
      (event): event is SessionEvent<MessageEventData> => event.type === "planner.message",
    );
  }

  pins(): string[] {
    return this.#events
      .filter((event) => event.type === "pin.added")
      .map((event) => String(event.data.text));
  }

  latestModel(): string | undefined {
    let model: string | undefined;
    for (const event of this.#events) {
      if (event.type === "model.selected") model = String(event.data.model ?? "") || model;
      if (event.type === "planner.message" && typeof event.data.requestedModel === "string") {
        model = event.data.requestedModel || model;
      }
    }
    return model;
  }

  latestEffort(): string | undefined {
    const selected = this.#events.findLast((event) => event.type === "effort.selected");
    return selected && typeof selected.data.effort === "string"
      ? selected.data.effort
      : undefined;
  }

  projectInstructions(): ProjectInstructionsEventData | undefined {
    const event = this.#events.find((entry) => entry.type === "project.instructions");
    if (!event || typeof event.data.path !== "string") return undefined;
    return {
      path: event.data.path,
      text: typeof event.data.text === "string" ? event.data.text : null,
    };
  }

  projectSkills(): ProjectSkillsSnapshot | undefined {
    const event = this.#events.find((entry) => entry.type === "project.skills");
    if (!event) return undefined;
    const { directory, skills, diagnostics } = event.data;
    if (typeof directory !== "string" || !Array.isArray(skills) || !Array.isArray(diagnostics) ||
      !skills.every(skill => skill && typeof skill.name === "string" && typeof skill.description === "string" && typeof skill.path === "string") ||
      !diagnostics.every(diagnostic => typeof diagnostic === "string")) {
      throw new Error("Invalid project skill catalog snapshot in session.");
    }
    return structuredClone({ directory, skills, diagnostics });
  }

  latestName(): SessionNameEventData | undefined {
    const event = this.#events.findLast((entry) => entry.type === "session.named");
    if (!event || typeof event.data.name !== "string") return undefined;
    const name = normalizeSessionName(event.data.name);
    if (!name) return undefined;
    const source = event.data.source === "manual" ? "manual" : "generated";
    return {
      name,
      source,
      ...(typeof event.data.model === "string" ? { model: event.data.model } : {}),
    };
  }

  fallbackName(): string {
    const created = this.#events.find((entry) => entry.type === "session.created");
    return typeof created?.data.fallbackName === "string" && created.data.fallbackName
      ? created.data.fallbackName
      : fallbackSessionName(this.sessionId);
  }

  displayName(): string {
    return this.latestName()?.name ?? this.fallbackName();
  }

  namingAttempted(): boolean {
    return this.#events.some(
      (entry) => entry.type === "session.named" || entry.type === "session.name.failed",
    );
  }

  async setName(name: string, source: SessionNameEventData["source"], model?: string): Promise<string> {
    const normalized = normalizeSessionName(name);
    if (!normalized) throw new Error("Session name cannot be empty.");
    if (!this.#ready) await this.initialize();
    const operation = this.#tail.then(async () => {
      // Serialize the check with writes so a queued manual name always wins.
      if (source === "generated") {
        const existing = this.latestName();
        if (existing) return existing.name;
      }
      await this.#appendNow("session.named", {
        name: normalized,
        source,
        ...(model ? { model } : {}),
      });
      return normalized;
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  latestPluginCatalog(): string | undefined {
    const event = this.#events.findLast((entry) => entry.type === "plugin.catalog");
    return event ? String(event.data.catalog ?? "") : undefined;
  }

  latestPublishedPluginCatalog(): string | undefined {
    const event = this.#events.findLast(
      (entry) =>
        entry.type === "planner.message" &&
        typeof entry.data.pluginCatalog === "string",
    );
    return event ? String(event.data.pluginCatalog) : undefined;
  }

  /**
   * Make every persisted assistant tool call have a terminal tool result. This
   * runs on restoration or interruption; it never re-runs external work.
   */
  async recoverInterruptedToolCalls(
    options: RecoverToolCallsOptions = {},
  ): Promise<InterruptedToolCall[]> {
    await this.initialize();
    await this.flush();

    const messages = this.plannerMessageEvents();
    const completed = new Set(
      messages
        .map((event) => event.data.message)
        .filter((message) => message.role === "tool" && message.tool_call_id)
        .map((message) => message.tool_call_id as string),
    );
    const started = new Map<string, SessionEvent>();
    const terminal = new Map<string, SessionEvent>();
    for (const event of this.#events) {
      const callId = typeof event.data.callId === "string" ? event.data.callId : undefined;
      if (!callId) continue;
      if (event.type === "graph.started") started.set(callId, event);
      if (event.type === "graph.finished" || event.type === "graph.interrupted") {
        terminal.set(callId, event);
      }
    }

    const recovered: InterruptedToolCall[] = [];
    const status = options.status ?? "interrupted";
    const reason = options.reason ??
      "Session restarted before execution completed. Inspect existing evidence and decide how to recover; do not assume the graph can be replayed safely.";
    // Early effects may precede a complete assistant/tool message. Preserve
    // that evidence as a standalone observation, never invent a tool call.
    const streamStarts = this.#events.filter(event => event.type === "graph.stream.started");
    const published = new Set(this.#events.filter(event => event.type === "graph.stream.published").map(event => event.data.streamId));
    const emittedCalls = new Set(messages.flatMap(event => event.data.message.tool_calls?.map(call => call.id) ?? []));
    for (const stream of streamStarts) {
      const streamId = stream.data.streamId as string;
      if (published.has(streamId)) continue;
      const bound = this.#events.findLast(event => event.type === "graph.stream.bound" && event.data.streamId === streamId);
      const finished = this.#events.findLast(event => event.type === "graph.stream.finished" && event.data.streamId === streamId);
      const callId = bound?.data.callId as string | undefined;
      if (callId && emittedCalls.has(callId)) {
        started.set(callId, stream);
        if (finished) terminal.set(callId, { ...finished, type: "graph.finished" });
        continue;
      }
      const evidence = finished?.data.report ?? {
        graphId: stream.data.graphId, status, reason,
        recordPath: stream.data.recordPath, error: finished?.data.error,
      };
      const artifact = await this.saveArtifact(`${streamId}-interrupted-stream.json`, JSON.stringify(evidence), "application/json");
      await this.appendMessage({ role: "system", content: [
        "A previous planner response ended after early graph execution had begun. Its complete tool call was not saved.",
        "Completed effects may already exist. Do not replay the graph automatically; inspect its saved evidence first.",
        `Graph: ${stream.data.graphId}. Evidence: ${artifact.path}. Execution records: ${stream.data.recordPath}.`,
      ].join("\n") });
      await this.append("notice", { text: "Interrupted graph generation left saved execution evidence; no work was replayed." });
      await this.append("graph.stream.published", { streamId, recovered: true });
      recovered.push({ callId: callId ?? streamId, graphId: stream.data.graphId, graph: stream.data.graph, started: true });
    }
    for (const event of messages) {
      const message = event.data.message;
      if (message.role !== "assistant") continue;
      for (const call of message.tool_calls ?? []) {
        if (completed.has(call.id)) continue;
        let graph: unknown = undefined;
        try {
          graph = JSON.parse(call.function.arguments);
        } catch {
          graph = call.function.arguments;
        }
        const start = started.get(call.id);
        const graphId = String(start?.data.graphId ?? `interrupted-${call.id}`);
        const recovery = { callId: call.id, graphId, graph, started: Boolean(start) };

        const terminalEvent = terminal.get(call.id);
        if (terminalEvent?.type === "graph.finished") {
          const fullContent = terminalEvent.data.report !== undefined
            ? JSON.stringify(terminalEvent.data.report)
            : JSON.stringify({
                status: terminalEvent.data.status ?? "error",
                graphId: terminalEvent.data.graphId ?? graphId,
                error: terminalEvent.data.error,
                recoveredFromSession: true,
              });
          const content = await excerptOversizedOutput(this, `${graphId}-recovered-result.json`, fullContent, 4_000);
          await this.appendMessage({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content,
          });
          completed.add(call.id);
          continue;
        }

        if (!terminalEvent) {
          await this.append("graph.interrupted", {
            ...recovery,
            status,
            reason,
          });
        }
        await this.appendMessage({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify({
            status,
            graphId,
            started: Boolean(start),
            reason,
            ...(start?.data.recordPath ? {recordPath: start.data.recordPath} : {}),
          }),
        });
        completed.add(call.id);
        recovered.push(recovery);
      }
    }
    for (const stream of streamStarts) {
      if (published.has(stream.data.streamId)) continue;
      const bound = this.#events.findLast(event => event.type === "graph.stream.bound" && event.data.streamId === stream.data.streamId);
      if (bound && completed.has(bound.data.callId)) await this.append("graph.stream.published", { streamId: stream.data.streamId, callId: bound.data.callId, recovered: true });
    }
    await this.#closeInterruptedExecutionViews(reason);
    return recovered;
  }

  /** Close historical live indicators without replaying work or claiming new effects. */
  async #closeInterruptedExecutionViews(reason: string): Promise<void> {
    const graphs = new Map<string, ExecutionEvent[]>();
    for (const entry of this.#events) {
      if (entry.type !== "execution.event" || !entry.data.event) continue;
      const event = entry.data.event as ExecutionEvent;
      const events = graphs.get(event.graphId) ?? [];
      events.push(event); graphs.set(event.graphId, events);
    }
    for (const [graphId, events] of graphs) {
      if (events.some(event => event.type === "graph.finished")) continue;
      // A preview-only graph that already failed or was interrupted is closed.
      if (!events.some(event=>event.type==="graph.started") && events.some(event=>event.type==="graph.building.finished" && event.data.status!=="ready")) continue;
      let sequence = Math.max(...events.map(event=>event.sequence));
      const append = (type: ExecutionEvent["type"], data: Record<string,unknown>, nodeId?: string) => this.append("execution.event",{
        event: {graphId,sequence:++sequence,time:Date.now(),type,data,...(nodeId?{nodeId}:{})},
      });
      const started = this.#events.findLast(event=>event.type==="graph.started"&&event.data.graphId===graphId);
      const terminal = started && this.#events.findLast(event=>event.type==="graph.finished"&&event.data.callId===started.data.callId);
      if (terminal?.data.report) {
        await append("graph.finished",{report:terminal.data.report});
        continue;
      }
      await append("graph.building.finished",{status:"interrupted",error:reason});
      const nodes = new Map<string,NodeResult>();
      for (const event of events) {
        if (!event.nodeId) continue;
        if (event.type === "node.created") nodes.set(event.nodeId,{
          id:event.nodeId,label:String(event.data.label??event.nodeId),type:event.data.type as NodeResult["type"],status:"pending",
        });
        if (event.type === "node.started" && nodes.has(event.nodeId)) Object.assign(nodes.get(event.nodeId)!,{status:"running",startedAt:event.time});
        if (event.type === "node.finished") nodes.set(event.nodeId,event.data.result as NodeResult);
      }
      for (const result of nodes.values()) if (result.status === "pending" || result.status === "running") {
        await append("node.finished",{result:{...result,status:"cancelled",finishedAt:Date.now(),error:reason}},result.id);
      }
      await append("graph.finished",{status:"cancelled",reason});
    }
  }

  async saveArtifact(
    name: string,
    value: string | Uint8Array,
    mediaType = "text/plain",
  ): Promise<SessionArtifact> {
    await this.initialize();
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeArtifactName(name)}`;
    const path = join(this.artifactsDirectory, filename);
    await writeFile(path, bytes, { flag: "wx" });
    const artifact: SessionArtifact = {
      path,
      relativePath: relative(this.directory, path),
      bytes: bytes.byteLength,
      mediaType,
    };
    await this.append("artifact.saved", { ...artifact });
    return artifact;
  }

  async readArtifact(pathOrRelativePath: string): Promise<Uint8Array> {
    const path = resolve(this.directory, pathOrRelativePath);
    const artifactRoot = `${resolve(this.artifactsDirectory)}/`;
    if (!path.startsWith(artifactRoot)) {
      throw new Error("Artifact path escapes this session's artifacts directory.");
    }
    return new Uint8Array(await readFile(path));
  }

  search(query: string, limit = 50): ArchiveMatch[] {
    if (!query) return [];
    const needle = query.toLocaleLowerCase();
    const matches: ArchiveMatch[] = [];
    for (let index = 0; index < this.#events.length && matches.length < limit; index += 1) {
      const event = this.#events[index]!;
      if (JSON.stringify(event).toLocaleLowerCase().includes(needle)) {
        matches.push({ line: index + 1, event });
      }
    }
    return matches;
  }

  async exists(): Promise<boolean> {
    try {
      await stat(this.logPath);
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  async #readLog(): Promise<SessionEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.logPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const lines = raw.split("\n");
    const events: SessionEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as SessionEvent;
        if (
          !event ||
          typeof event !== "object" ||
          typeof event.sequence !== "number" ||
          typeof event.type !== "string" ||
          typeof event.id !== "string"
        ) {
          throw new Error("missing required event fields");
        }
        events.push(event);
      } catch (error) {
        // A process can die between writing bytes and the final newline. Ignore
        // only that trailing fragment; corruption in the middle is actionable.
        const hasLaterContent = lines.slice(index + 1).some((candidate) => candidate.trim());
        if (!hasLaterContent && !raw.endsWith("\n")) {
          const lastNewline = raw.lastIndexOf("\n");
          const validPrefix = raw.slice(0, lastNewline + 1);
          await truncate(this.logPath, new TextEncoder().encode(validPrefix).byteLength);
          return events;
        }
        throw new Error(
          `Invalid session JSONL at ${this.logPath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // A complete final JSON object is valid even if a crash lost only its line
    // terminator. Restore framing before the next append.
    if (raw && !raw.endsWith("\n")) await appendFile(this.logPath, "\n", "utf8");
    events.sort((left, right) => left.sequence - right.sequence);
    return events;
  }

  async #initializeOnce(): Promise<void> {
    if (this.existingOnly && !(await this.exists())) {
      throw new Error(`Session ${this.sessionId} does not exist in ${sessionsDirectory(this.cwd)}.`);
    }
    await mkdir(this.artifactsDirectory, { recursive: true });
    this.#events = await this.#readLog();
    this.#ready = true;
    if (this.#events.length === 0) {
      await this.append("session.created", {
        sessionId: this.sessionId,
        cwd: this.cwd,
        format: 1,
        fallbackName: fallbackSessionName(this.sessionId),
      });
    }
  }
}

function summaryFromEvents(
  sessionId: string,
  events: readonly SessionEvent[],
  modified: Date,
): SessionSummary | undefined {
  const created = events.find((event) => event.type === "session.created");
  if (!created) return undefined;
  const named = events.findLast((event) => event.type === "session.named");
  const explicitName = typeof named?.data.name === "string"
    ? normalizeSessionName(named.data.name)
    : "";
  const fallback = typeof created.data.fallbackName === "string" && created.data.fallbackName
    ? String(created.data.fallbackName)
    : fallbackSessionName(sessionId);
  let model: string | undefined;
  let effort: string | undefined;
  let messageCount = 0;
  for (const event of events) {
    if (event.type === "model.selected" && typeof event.data.model === "string") {
      model = event.data.model;
    }
    if (event.type === "effort.selected") {
      effort = typeof event.data.effort === "string" ? event.data.effort : undefined;
    }
    if (event.type === "planner.message") {
      const message = (event.data as Partial<MessageEventData>).message;
      if (message?.role === "user" || message?.role === "assistant") messageCount += 1;
      if (typeof event.data.requestedModel === "string") model = event.data.requestedModel;
    }
  }
  const createdAt = typeof created.timestamp === "string"
    ? created.timestamp
    : modified.toISOString();
  const lastTimestamp = events.findLast((event) => !Number.isNaN(Date.parse(event.timestamp)))?.timestamp;
  return {
    id: sessionId,
    name: explicitName || fallback,
    nameSource: explicitName
      ? named?.data.source === "manual" ? "manual" : "generated"
      : "fallback",
    createdAt,
    updatedAt: lastTimestamp ?? modified.toISOString(),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    messageCount,
  };
}

async function readSessionSummary(cwd: string, sessionId: string): Promise<SessionSummary | undefined> {
  const logPath = join(sessionDirectory(cwd, sessionId), "session.jsonl");
  const info = await stat(logPath);
  const events: SessionEvent[] = [];
  const lines = createInterface({
    input: createReadStream(logPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as SessionEvent;
      if (event && typeof event === "object" && typeof event.type === "string") events.push(event);
    } catch {
      // Discovery is read-only and best-effort. Opening the session reports exact corruption.
    }
  }
  return summaryFromEvents(sessionId, events, info.mtime);
}

/** Read lightweight picker metadata without loading every log into memory at once. */
export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  let entries;
  try {
    entries = await readdir(sessionsDirectory(cwd), { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const ids = entries
    .filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  const summaries: Array<SessionSummary | undefined> = new Array(ids.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(8, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++;
      try {
        summaries[index] = await readSessionSummary(cwd, ids[index]!);
      } catch {
        summaries[index] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return summaries
    .filter((summary): summary is SessionSummary => summary !== undefined)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

/** Exact IDs win; otherwise accept only an unambiguous prefix. */
export async function resolveSessionReference(cwd: string, reference: string): Promise<string> {
  const value = reference.trim();
  assertSessionId(value);
  const exact = new SessionStore({ cwd, sessionId: value, existingOnly: true });
  if (await exact.exists()) return value;
  let entries;
  try {
    entries = await readdir(sessionsDirectory(cwd), { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) throw new Error(`No saved sessions exist in ${sessionsDirectory(cwd)}.`);
    throw error;
  }
  const matches = entries
    .filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name) && entry.name.startsWith(value))
    .map((entry) => entry.name);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Session reference ${JSON.stringify(value)} is ambiguous.`);
  throw new Error(`Session ${JSON.stringify(value)} was not found in ${sessionsDirectory(cwd)}.`);
}
