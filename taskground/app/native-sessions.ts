import { Database } from "bun:sqlite";
import { open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RunRecord } from "./runner";

export function nativeSessionRoot(agent: RunRecord["agent"], env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (agent === "codex") return resolve(env.CODEX_HOME ?? join(homedir(), ".codex"));
  if (agent === "claude") return resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
}

const entries = (directory: string) => readdir(directory, { withFileTypes: true }).catch(() => []);
const canonical = (path: string) => realpath(path).catch(() => resolve(path));

/** Match the native session's actual cwd; never attribute a child agent's turn to its parent. */
async function codexSessionMatches(path: string, workspaces: Set<string>): Promise<boolean> {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return false;
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < 2 * 1024 * 1024) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      const newline = buffer.indexOf(10, 0);
      chunks.push(buffer.subarray(0, newline >= 0 && newline < bytesRead ? newline : bytesRead));
      if (newline >= 0 && newline < bytesRead) break;
    }
    const first = Buffer.concat(chunks).toString("utf8");
    const value = JSON.parse(first);
    const meta = value.type === "session_meta" ? value.payload : undefined;
    return typeof meta?.cwd === "string" && workspaces.has(await canonical(meta.cwd)) &&
      !(meta.source && typeof meta.source === "object" && (meta.source.subagent || meta.source.sub_agent));
  } catch { return false; } finally { await file.close(); }
}

export async function nativeSessionPaths(run: RunRecord): Promise<string[]> {
  const home = run.sessionRoot ?? nativeSessionRoot(run.agent);
  if (!home) return [];
  const cwd = await canonical(run.workspace);
  const workspaces = new Set([resolve(run.workspace), cwd]);
  if (run.agent === "claude") {
    const paths: string[] = [];
    for (const workspace of workspaces) {
      const directory = join(home, "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"));
      for (const entry of await entries(directory)) if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(join(directory, entry.name));
    }
    return [...new Set(paths)];
  }
  const paths = new Set<string>();
  // Newer Codex installations index rollout paths in a local SQLite database.
  for (const entry of await entries(home)) {
    if (!/^state_\d+\.sqlite$/.test(entry.name)) continue;
    let db: Database | undefined;
    try {
      db = new Database(join(home, entry.name), { readonly: true });
      for (const workspace of workspaces) {
        const rows = db.query("SELECT rollout_path FROM threads WHERE cwd = ?").all(workspace) as { rollout_path: string }[];
        for (const row of rows) if (typeof row.rollout_path === "string") paths.add(row.rollout_path);
      }
    } catch { /* Older installations can be discovered from their rollout headers. */ }
    finally { db?.close(); }
  }
  if (!paths.size) {
    const startDay = new Date(Date.parse(run.startedAt ?? run.createdAt) - 86400000).toISOString().slice(0, 10);
    const endDay = new Date((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) + 86400000).toISOString().slice(0, 10);
    for (const year of await entries(join(home, "sessions"))) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      for (const month of await entries(join(home, "sessions", year.name))) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
        for (const day of await entries(join(home, "sessions", year.name, month.name))) {
          const date = `${year.name}-${month.name}-${day.name}`;
          if (!day.isDirectory() || date < startDay || date > endDay) continue;
          const directory = join(home, "sessions", year.name, month.name, day.name);
          for (const entry of await entries(directory)) if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.add(join(directory, entry.name));
        }
      }
    }
  }
  const matched: string[] = [];
  for (const path of paths) if (await codexSessionMatches(path, workspaces)) matched.push(path);
  return matched;
}
