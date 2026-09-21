import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunRecord, RunStatus } from "./runner";
import { nativeSessionPaths } from "./native-sessions";

export interface TaskActivity {
  status: "running" | "completed" | "failed" | "cancelled";
  at: string;
  source: string;
}

type RecordValue = Record<string, any>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);

/** Only task/turn boundaries count: a graph or tool finishing is not task completion. */
export function activityEvent(agent: RunRecord["agent"], value: unknown, source: string): TaskActivity | undefined {
  if (!record(value)) return;
  const time = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
  if (!Number.isFinite(time)) return;
  let status: TaskActivity["status"] | undefined;
  if (agent === "jive") {
    const message = value.data?.message;
    if (value.type === "planner.request" || value.type === "planner.message" && message?.role === "user") status = "running";
    if (value.type === "planner.message" && message?.role === "assistant" && (!message.tool_calls || message.tool_calls.length === 0)) status = "completed";
    if (value.type === "transport.error") status = "failed";
    if (value.type === "notice" && value.data?.text === "Interrupted. Completed effects remain recorded; no operation was replayed.") status = "cancelled";
  } else if (agent === "codex" && value.type === "event_msg") {
    const type = value.payload?.type;
    if (type === "task_started" || type === "turn_started") status = "running";
    if (type === "task_complete" || type === "turn_complete") status = "completed";
    if (type === "turn_aborted") status = "cancelled";
    if (type === "error") status = "failed";
  } else if (agent === "claude" && !value.isSidechain) {
    const message = value.message;
    if (value.type === "user" && !value.isMeta && !value.toolUseResult) {
      const content = message?.content;
      if (typeof content === "string" || Array.isArray(content) && content.some(part => part?.type === "text")) status = "running";
      if (typeof content === "string" && /^\[Request interrupted by user(?: for tool use)?\]$/.test(content)) status = "cancelled";
      if (value.interruptedMessageId) status = "cancelled";
    }
    if (value.type === "assistant") {
      if (message?.stop_reason === "tool_use") status = "running";
      if (value.isApiErrorMessage) status = "failed";
    }
    // Stop hooks can continue after end_turn text. The root turn_duration record
    // is written when the native turn actually returns to its input loop.
    if (value.type === "system" && value.subtype === "turn_duration") status = "completed";
  }
  return status ? { status, at: new Date(time).toISOString(), source } : undefined;
}

interface Cursor { offset: number; partial: Buffer; activity?: TaskActivity; inode: number }
interface Cache { files: Map<string, Cursor>; work: Promise<unknown>; paths?: string[]; discoveryAt?: number }
const caches = new Map<string, Cache>();

async function activityPaths(run: RunRecord): Promise<string[]> {
  if (run.agent !== "jive") return nativeSessionPaths(run);
  const directory = join(run.workspace, ".jev/sessions");
  return (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name, "session.jsonl"));
}

async function scan(run: RunRecord, path: string, cache: Cache) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return;
  let cursor = cache.files.get(path);
  if (!cursor || info.size < cursor.offset || info.ino !== cursor.inode) {
    cursor = { offset: 0, partial: Buffer.alloc(0), inode: info.ino };
    cache.files.set(path, cursor);
  }
  if (cursor.offset === info.size) return;
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return;
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Infinity;
  const workspaces = new Set([resolve(run.workspace), await realpath(run.workspace).catch(() => resolve(run.workspace))]);
  const consume = (line: Buffer) => {
    try {
      const value = JSON.parse(line.toString("utf8"));
      if (run.agent === "claude" && (typeof value.cwd !== "string" || !workspaces.has(resolve(value.cwd)))) return;
      const activity = activityEvent(run.agent, value, path);
      // Native end-of-turn markers also follow error/interruption records.
      if (run.agent !== "jive" && activity?.status === "completed" && ["failed", "cancelled"].includes(cursor!.activity?.status ?? "")) activity.status = cursor!.activity!.status;
      if (activity && Date.parse(activity.at) >= start && Date.parse(activity.at) <= end &&
        (!cursor!.activity || activity.at >= cursor!.activity.at)) cursor!.activity = activity;
    } catch { /* Keep diagnostics and incomplete records out of lifecycle state. */ }
  };
  try {
    while (cursor.offset < info.size) {
      const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, info.size - cursor.offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor.offset);
      if (!bytesRead) break;
      cursor.offset += bytesRead;
      const data = Buffer.concat([cursor.partial, buffer.subarray(0, bytesRead)]);
      let offset = 0, newline: number;
      while ((newline = data.indexOf(10, offset)) !== -1) {
        consume(data.subarray(offset, newline)); offset = newline + 1;
      }
      cursor.partial = Buffer.from(data.subarray(offset));
      if (cursor.partial.length > 8 * 1024 * 1024) cursor.partial = Buffer.alloc(0);
    }
  } finally { await file.close(); }
}

export async function readTaskActivity(run: RunRecord): Promise<TaskActivity | undefined> {
  if (run.mode !== "terminal" || !run.startedAt) return;
  let cache = caches.get(run.directory);
  if (!cache) {
    cache = { files: new Map(), work: Promise.resolve() };
    caches.set(run.directory, cache);
    if (caches.size > 256) caches.delete(caches.keys().next().value!);
  }
  const current = cache;
  const work = current.work.catch(() => {}).then(async () => {
    if (!current.paths?.length || run.agent === "jive" || Date.now() - (current.discoveryAt ?? 0) > 10000) {
      current.paths = await activityPaths(run);
      current.discoveryAt = Date.now();
    }
    const paths = current.paths;
    await Promise.all(paths.map(path => scan(run, path, current)));
    const activities = paths.map(path => current.files.get(path)?.activity).filter((item): item is TaskActivity => !!item);
    return activities.sort((a, b) => b.at.localeCompare(a.at))[0];
  });
  current.work = work;
  return work;
}

export type TaskRunView = RunRecord & { processStatus: RunStatus; activity?: TaskActivity };

/** Project task status without overwriting the supervisor's process-owned run.json. */
export async function taskRunView(run: RunRecord): Promise<TaskRunView> {
  const activity = await readTaskActivity(run);
  const view: TaskRunView = { ...run, processStatus: run.status, activity };
  if (run.grading.activityAt && run.grading.activityAt !== activity?.at) view.grading = { status: "ungraded", attempts: run.grading.attempts };
  if (!activity || ["preparing", "starting", "ready"].includes(run.status)) return view;
  if (activity.status === "running") return view;
  view.status = activity.status;
  view.finishedAt = activity.at;
  view.elapsedMs = Math.max(0, Date.parse(activity.at) - Date.parse(run.startedAt!));
  return view;
}
