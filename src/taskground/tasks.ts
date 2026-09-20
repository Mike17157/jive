import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, lstat } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const DEFINITIONS = join(REPO_ROOT, "taskground/task_definitions");
export const RUNS = join(REPO_ROOT, "taskground/task_runs");
export const SHARED = join(REPO_ROOT, "taskground/_shared");
export const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;

export interface Task {
  schemaVersion: 1;
  id: string;
  title: string;
  description: string;
  estimatedCalls?: number;
  setup?: string[];
  verify?: string[];
}

export async function loadTask(directory: string): Promise<Task> {
  const task = JSON.parse(await readFile(join(directory, "task.json"), "utf8"));
  if (task.schemaVersion !== 1 || !ID.test(task.id ?? "") || typeof task.title !== "string" || typeof task.description !== "string") {
    throw new Error(`Invalid task manifest: ${directory}/task.json`);
  }
  for (const key of ["setup", "verify"]) {
    if (task[key] !== undefined && (!Array.isArray(task[key]) || !task[key].length || !task[key].every((v: unknown) => typeof v === "string" && v.length))) {
      throw new Error(`${key} must be a nonempty command argument array`);
    }
  }
  if (task.estimatedCalls !== undefined && (!Number.isInteger(task.estimatedCalls) || task.estimatedCalls < 0 || task.estimatedCalls > 200)) {
    throw new Error("Initial task profiles must fit within 200 estimated calls");
  }
  await readFile(join(directory, "instruction.md"), "utf8");
  if (!(await lstat(join(directory, "workspace"))).isDirectory()) throw new Error("Task needs a workspace directory");
  return task;
}

export async function listTasks(): Promise<Task[]> {
  const entries = await readdir(DEFINITIONS, { withFileTypes: true });
  return await Promise.all(entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map(e => loadTask(join(DEFINITIONS, e.name))));
}

const excluded = (name: string) => name === ".env" || name.startsWith(".env.") && name !== ".env.example" || [".git", ".jev", ".context", ".cache", "node_modules", "__pycache__", ".DS_Store"].includes(name);

/** Definitions contain fixtures only. Never copy credentials, session state, or symlinks. */
export async function copyDefinition(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    filter: async path => {
      const parts = relative(source, path).split(sep);
      if (parts.some(excluded)) return false;
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`Task fixtures cannot contain symlinks: ${path}`);
      return true;
    },
  });
}

export async function fingerprint(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded(entry.name)) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        hash.update(relative(directory, full)).update("\0").update(String(bytes.length)).update("\0").update(bytes);
      }
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

export async function writeJSON(path: string, value: unknown): Promise<void> {
  const { writeFile, rename } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
