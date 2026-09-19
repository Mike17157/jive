/**
 * Working-tree changes attributable to one graph execution.
 *
 * Git decides which files count: a porcelain status is taken before the run and another
 * after it, so ignored paths and the run's own .jev artifacts never appear. Line counts
 * come from `git diff --numstat HEAD` taken at the same two moments and subtracted, so
 * edits the user already had in the tree are not billed to the graph. A file that was
 * untracked before the run has no HEAD to count against: one the graph created is counted
 * in full, one it only edited is reported without counts.
 *
 * Every failure mode — no git, no repository, no HEAD, a timeout — degrades to null, and
 * the caller simply shows nothing.
 */
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

/** Paths the runtime writes itself; they are never the graph's work. */
const INTERNAL = /(^|\/)\.jev\//;
/** Beyond this the tree is not worth scanning; the summary is dropped. */
const MAX_TRACKED_PATHS = 4000;
/** A created file is counted by reading it, so only small text files are counted. */
const MAX_COUNT_BYTES = 1_000_000;
const MAX_COUNTED_FILES = 32;
/** A tree too slow to read is not worth delaying the run for. */
const GIT_TIMEOUT_MS = 3000;

export interface FileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  /** Omitted when the change cannot be counted (binary, oversized, or no baseline). */
  added?: number;
  removed?: number;
}

export interface FileChangeSummary {
  /** Changed files, largest first, capped by the caller's limit. */
  files: FileChange[];
  /** Total changed files, including the ones left out of `files`. */
  total: number;
  added: number;
  removed: number;
}

interface Entry {
  code: string;
  size: number;
  mtimeMs: number;
  added?: number;
  removed?: number;
}

export interface WorkingTreeSnapshot {
  /** Repository root: git reports every path relative to it, whatever the working directory is. */
  root: string;
  entries: Map<string, Entry>;
}

/** Run git for its stdout; null for any failure, including git being absent. */
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null;
  return await new Promise<string | null>((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      done(null);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      done(value);
    };
    const abort = () => { child.kill("SIGKILL"); finish(null); };
    const timer = setTimeout(abort, GIT_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { out += chunk; });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code === 0 ? out : null));
  });
}

/** `XY path` records, NUL terminated. */
function parseStatus(text: string): Array<[string, string]> {
  return text
    .split("\0")
    .filter((record) => record.length > 3)
    .map((record) => [record.slice(0, 2), record.slice(3)] as [string, string]);
}

/** `added \t removed \t path` records, NUL terminated; "-" marks a binary file. */
function parseNumstat(text: string): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>();
  for (const record of text.split("\0")) {
    const fields = record.split("\t");
    if (fields.length < 3) continue;
    const added = Number(fields[0]);
    const removed = Number(fields[1]);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
    out.set(fields[2]!, { added, removed });
  }
  return out;
}

/** The dirty paths of a working tree with enough detail to tell later what a run changed. */
export async function snapshotWorkingTree(cwd: string, signal?: AbortSignal): Promise<WorkingTreeSnapshot | null> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal))?.trim();
  if (!root) return null;
  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], signal);
  if (status === null) return null;
  const listed = parseStatus(status).filter(([, path]) => !INTERNAL.test(path));
  if (listed.length > MAX_TRACKED_PATHS) return null;
  const numstat = parseNumstat((await git(cwd, ["diff", "--numstat", "-z", "--no-renames", "HEAD"], signal)) ?? "");
  const entries = new Map<string, Entry>();
  await Promise.all(listed.map(async ([code, path]) => {
    const info = await stat(`${root}/${path}`).catch(() => undefined);
    entries.set(path, {
      code,
      size: info?.isFile() ? info.size : -1,
      mtimeMs: info?.mtimeMs ?? 0,
      ...(numstat.get(path) ?? {}),
    });
  }));
  return { root, entries };
}

/** Lines in a newly created file, or undefined when it is binary or too large to read. */
async function countLines(root: string, path: string, size: number): Promise<number | undefined> {
  if (size < 0 || size > MAX_COUNT_BYTES) return undefined;
  const content = await readFile(`${root}/${path}`).catch(() => undefined);
  if (content === undefined) return undefined;
  if (content.length === 0) return 0;
  if (content.subarray(0, 8192).includes(0)) return undefined;
  let lines = 0;
  for (const byte of content) if (byte === 10) lines += 1;
  return content.at(-1) === 10 ? lines : lines + 1;
}

function kindOf(before: Entry | undefined, after: Entry | undefined): FileChange["kind"] {
  if (after && after.code.includes("D")) return "deleted";
  if (!after) return before?.code === "??" ? "deleted" : "modified";
  if (!before) return after.code.includes("?") || after.code.includes("A") ? "added" : "modified";
  return "modified";
}

/** True when the graph could have touched this path: content, status or timestamp moved. */
function moved(before: Entry | undefined, after: Entry | undefined): boolean {
  if (!before || !after) return true;
  return before.code !== after.code
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.added !== after.added
    || before.removed !== after.removed;
}

/** What changed in the tree since `before`, or null when the tree cannot be compared. */
export async function changesSince(
  before: WorkingTreeSnapshot | null,
  cwd: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<FileChangeSummary | null> {
  if (!before) return null;
  const after = await snapshotWorkingTree(cwd, options.signal);
  if (!after) return null;
  const files: FileChange[] = [];
  let counted = 0;
  for (const path of new Set([...before.entries.keys(), ...after.entries.keys()])) {
    const b = before.entries.get(path);
    const a = after.entries.get(path);
    if (!moved(b, a)) continue;
    const change: FileChange = { path, kind: kindOf(b, a) };
    if (a?.added !== undefined && b?.added !== undefined) {
      // Both sides are measured against HEAD, so their difference is this run's share.
      change.added = Math.max(0, a.added - b.added);
      change.removed = Math.max(0, a.removed! - b.removed!);
    } else if (a?.added !== undefined && b === undefined) {
      // The file was clean when the run started, so the whole diff belongs to it.
      change.added = a.added;
      change.removed = a.removed;
    } else if (change.kind === "added" && a && counted < MAX_COUNTED_FILES) {
      counted += 1;
      const lines = await countLines(after.root, path, a.size);
      if (lines !== undefined) { change.added = lines; change.removed = 0; }
    }
    files.push(change);
  }
  if (files.length === 0) return null;
  files.sort((left, right) => size(right) - size(left) || left.path.localeCompare(right.path));
  return {
    files: files.slice(0, options.limit ?? 3),
    total: files.length,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
  };
}

function size(change: FileChange): number {
  return (change.added ?? 0) + (change.removed ?? 0);
}
