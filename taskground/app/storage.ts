import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { RUNS, writeJSON } from "./tasks";
import { primarySource } from "./source";
import { runStatus, type RunRecord } from "./runner";

export async function dataDirectory() {
  if (process.env.TASKGROUND_DATA_DIR) return resolve(process.env.TASKGROUND_DATA_DIR);
  const source = await primarySource();
  const project = createHash("sha256").update(source.directory).digest("hex").slice(0, 12);
  return join(homedir(), ".local/share/taskground", project);
}

export async function defaultRunsRoot() { return join(await dataDirectory(), "runs"); }

export async function registerRunsRoot(root: string) {
  const data = await dataDirectory();
  await mkdir(join(data, "roots"), { recursive: true, mode: 0o700 });
  const path = resolve(root);
  await writeJSON(join(data, "roots", createHash("sha256").update(path).digest("hex") + ".json"), { path });
}

export async function runsRoots(extra?: string) {
  const data = await dataDirectory();
  const source = await primarySource();
  const roots = new Set([await defaultRunsRoot(), RUNS, join(source.directory, "taskground/task_runs"), ...(extra ? [resolve(extra)] : [])]);
  for (const name of await readdir(join(data, "roots")).catch(() => [])) {
    try { const entry = JSON.parse(await readFile(join(data, "roots", name), "utf8")); if (typeof entry.path === "string") roots.add(entry.path); } catch {}
  }
  return [...roots];
}

export async function listRuns(extra?: string): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  for (const root of await runsRoots(extra)) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      try { const run = await runStatus(entry.name, root); if (run.mode === "headless" || run.mode === "terminal") runs.push(run); } catch { /* Incomplete/unrelated folders are not runs. */ }
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function locateRun(id: string, extra?: string) {
  for (const root of await runsRoots(extra)) {
    try { return { root, run: await runStatus(id, root) }; } catch {}
  }
  throw new Error(`Run not found: ${id}`);
}
