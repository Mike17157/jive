import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { executeGraph } from "../src/core/executor";
import { changesSince, snapshotWorkingTree } from "../src/core/file-changes";
import type { ExecutionEvent, Graph } from "../src/core/types";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

/** A repository with one commit: three lines in kept.txt and one in gone.txt. */
async function repository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jev-changes-"));
  directories.push(path);
  git(path, "init", "-q", ".");
  await writeFile(join(path, "kept.txt"), "a\nb\nc\n");
  await writeFile(join(path, "gone.txt"), "x\n");
  git(path, "add", "-A");
  git(path, "-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-qm", "init");
  return path;
}

function script(cwd: string, body: string): Graph {
  return { version: 1, label: "edit files", nodes: { edit: { type: "bash", script: body, cwd } } };
}

async function run(cwd: string, body: string) {
  const events: ExecutionEvent[] = [];
  await executeGraph(script(cwd, body), { cwd, onEvent: event => events.push(event) });
  return events.find(event => event.type === "graph.finished")!.data.changes as
    | { files: Array<{ path: string; kind: string; added?: number; removed?: number }>; total: number; added: number; removed: number }
    | undefined;
}

test("a run reports the files it changed, counted against the state it started from", async () => {
  const cwd = await repository();
  // An edit the user already had in the tree must not be billed to the run.
  await writeFile(join(cwd, "kept.txt"), "a\nb\nc\nuser\n");
  const changes = await run(cwd, "printf 'a\\nb\\nc\\nuser\\nnode\\n' > kept.txt; rm gone.txt; printf 'one\\ntwo\\n' > made.txt");
  expect(changes).toBeDefined();
  expect(changes!.total).toBe(3);
  const byPath = Object.fromEntries(changes!.files.map(file => [file.path, file]));
  expect(byPath["kept.txt"]).toMatchObject({ kind: "modified", added: 1, removed: 0 });
  expect(byPath["gone.txt"]).toMatchObject({ kind: "deleted", added: 0, removed: 1 });
  expect(byPath["made.txt"]).toMatchObject({ kind: "added", added: 2, removed: 0 });
  expect(changes!.added).toBe(3);
  expect(changes!.removed).toBe(1);
});

test("files the run never touched, and its own artifacts, stay out of the summary", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "untouched.txt"), "left alone\n");
  const changes = await run(cwd, "printf 'd\\n' >> kept.txt");
  expect(changes!.files.map(file => file.path)).toEqual(["kept.txt"]);
  expect(changes!.total).toBe(1);
});

test("a run that changes nothing reports nothing", async () => {
  const cwd = await repository();
  expect(await run(cwd, "cat kept.txt > /dev/null")).toBeUndefined();
});

test("ignored paths are the repository's business, not the run's", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, ".gitignore"), "build/\n");
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-qm", "ignore");
  const changes = await run(cwd, "mkdir -p build; printf 'artifact\\n' > build/out.txt; printf 'd\\n' >> kept.txt");
  expect(changes!.files.map(file => file.path)).toEqual(["kept.txt"]);
});

test("the summary is reported only inside a repository, and only up to the listed cap", async () => {
  const outside = await mkdtemp(join(tmpdir(), "jev-nogit-"));
  directories.push(outside);
  expect(await snapshotWorkingTree(outside)).toBeNull();
  expect(await run(outside, "printf 'x\\n' > file.txt")).toBeUndefined();

  const cwd = await repository();
  const before = await snapshotWorkingTree(cwd);
  await mkdir(join(cwd, "many"), { recursive: true });
  for (let index = 0; index < 5; index += 1) await writeFile(join(cwd, "many", `f${index}.txt`), `${index}\n`);
  const changes = await changesSince(before, cwd, { limit: 3 });
  expect(changes!.total).toBe(5);
  expect(changes!.files).toHaveLength(3);
});

test("tracking can be turned off", async () => {
  const cwd = await repository();
  const events: ExecutionEvent[] = [];
  await executeGraph(script(cwd, "printf 'd\\n' >> kept.txt"), { cwd, trackFileChanges: false, onEvent: event => events.push(event) });
  expect(events.find(event => event.type === "graph.finished")!.data.changes).toBeUndefined();
});
