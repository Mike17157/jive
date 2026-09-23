import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentCommand, OPENROUTER_NOTE } from "../taskground/app/agents";
import { prepareRun, executeRun, detachRun, readRun, stopRun, verifyRun, parseDotEnv, runStatus, logTail, type RunRecord } from "../taskground/app/runner";
import { DEFINITIONS, copyDefinition, fingerprint, listTasks, writeJSON } from "../taskground/app/tasks";
import { capture } from "../taskground/app/process";

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "jive-taskground-test-"));
  temporary.push(directory);
  return directory;
}
async function fixture(options: { task?: string; agent?: "jive" | "codex" | "claude"; executable?: string; extraArgs?: string[]; timeoutSeconds?: number } = {}) {
  const root = await scratch();
  return await prepareRun({ task: options.task ?? "intent_routing", agent: options.agent ?? "codex", headless: true, runsRoot: root, ...options });
}
async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }
async function jsonl(path: string, records: unknown[]) { await writeFile(path, records.map(row => JSON.stringify(row)).join("\n") + "\n"); }
async function waitFor(check: () => Promise<boolean>, timeout = 10000) {
  const started = Date.now();
  while (!await check()) { if (Date.now() - started > timeout) throw new Error("Timed out waiting for fake agent"); await Bun.sleep(50); }
}

async function fakeAgent(root: string) {
  const path = join(root, "fake agent.mjs");
  await writeFile(path, `#!${process.execPath}
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('fake-agent 1.0'); process.exit(0); }
mkdirSync('work', { recursive: true });
writeFileSync('work/received.json', JSON.stringify({ cwd:process.cwd(), argv:process.argv.slice(2), hasKey:!!process.env.OPENROUTER_API_KEY }));
console.log(JSON.stringify({ type:'fake.started' }));
if (process.argv.includes('--hold')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached:true, stdio:'ignore' });
  writeFileSync('work/child.pid', String(child.pid));
  setInterval(() => {}, 1000);
} else {
  process.exit(process.argv.includes('--fail') ? 7 : 0);
}
`, { mode: 0o700 });
  return path;
}

test("bundled tasks fit the allowance; dataset adaptations hide answer fields", async () => {
  const tasks = await listTasks();
  expect(tasks.map(t => t.id)).toEqual(expect.arrayContaining(["async_blocking_audit", "conversation_eval", "error_handling_audit", "intent_routing", "product_matching", "retry_audit", "search_latency", "sembench_movie"]));
  for (const task of tasks) {
    expect(task.estimatedCalls).toBeLessThanOrEqual(200);
    const source = await json(join(DEFINITIONS, task.id, "SOURCE.json"));
    // Recording fixtures are not graded, so their labels may sit in the workspace.
    if (source.demo === true) {
      expect(task.verify).toBeUndefined();
      continue;
    }
    if (["async_blocking_audit", "error_handling_audit", "retry_audit"].includes(task.id)) {
      expect(task.verify).toBeDefined();
      continue;
    }
    if (task.setup) {
      expect(task.setup).toBeDefined();
      expect(task.verify).toBeDefined();
      continue;
    }
    expect(source.adaptation).toBe(true);
    const rows = (await readFile(join(DEFINITIONS, task.id, "workspace/data/test.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    for (const row of rows) {
      for (const field of ["label", "labels", "intent", "match", "sentiment", "originalScore", "reviewState", "scoreSentiment", "cluster_id_left", "cluster_id_right", "is_hard_negative"]) expect(Object.hasOwn(row, field)).toBe(false);
    }
  }
});

test("fresh runs copy fixtures, share task guidance across profiles, and keep .env out of Git and metadata", async () => {
  const root = await scratch();
  const envFile = join(root, "task.env");
  const secret = "test-secret-that-must-not-enter-artifacts";
  await writeFile(envFile, `OPENROUTER_API_KEY='${secret}'\nUNRELATED_SECRET=do-not-copy\n`);
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const run = await prepareRun({ task: "intent_routing", agent: "codex", runsRoot: root, envFile });
    expect(parseDotEnv(await readFile(join(run.workspace, ".env"), "utf8"))).toEqual({ OPENROUTER_API_KEY: secret });
    expect((await stat(join(run.workspace, ".env"))).mode & 0o777).toBe(0o600);
    expect((await stat(run.directory)).mode & 0o777).toBe(0o700);
    expect(await capture(["git", "ls-files", ".env"], run.workspace)).toBe("");
    expect(await readFile(join(run.directory, "run.json"), "utf8")).not.toContain(secret);
    expect(await readFile(join(run.workspace, "README.md"), "utf8")).toContain(OPENROUTER_NOTE);
    expect(await readFile(join(run.definition, "workspace/README.md"), "utf8")).not.toContain("OpenRouter");
    const original = await readFile(join(run.workspace, "data/test.jsonl"), "utf8");
    await writeFile(join(run.workspace, "data/test.jsonl"), "changed");
    await writeFile(join(run.workspace, "work/old-result"), "stale");
    const next = await prepareRun({ task: "intent_routing", agent: "jive", runsRoot: root, envFile });
    expect(next.id).not.toBe(run.id);
    expect(await readFile(join(next.workspace, "data/test.jsonl"), "utf8")).toBe(original);
    expect(await Bun.file(join(next.workspace, "work/old-result")).exists()).toBe(false);
    expect(await readFile(join(next.workspace, "README.md"), "utf8")).toContain(OPENROUTER_NOTE);
    expect(await fingerprint(next.definition)).toBe(next.definitionHash!);
    const claude = await prepareRun({ task: "intent_routing", agent: "claude", runsRoot: root, envFile });
    expect(await readFile(join(claude.workspace, "README.md"), "utf8")).toContain(OPENROUTER_NOTE);
    for (const other of [next, claude]) {
      for (const file of ["README.md", "TASK.md"]) {
        expect(await readFile(join(other.workspace, file), "utf8")).toBe(await readFile(join(run.workspace, file), "utf8"));
      }
      expect(await readFile(join(other.directory, "prompt.txt"), "utf8")).toBe(await readFile(join(run.directory, "prompt.txt"), "utf8"));
    }
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("fixture copying refuses symlinks and excludes credentials and old sessions", async () => {
  const root = await scratch(), source = join(root, "source"), target = join(root, "target");
  await mkdir(join(source, ".jev"), { recursive: true });
  await writeFile(join(source, ".env"), "private");
  await writeFile(join(source, ".jev/session"), "old");
  await writeFile(join(source, "input.txt"), "fresh");
  await copyDefinition(source, target);
  expect(await Bun.file(join(target, ".env")).exists()).toBe(false);
  expect(await Bun.file(join(target, ".jev/session")).exists()).toBe(false);
  expect(await readFile(join(target, "input.txt"), "utf8")).toBe("fresh");
  await symlink(join(source, "input.txt"), join(source, "link"));
  await expect(copyDefinition(source, join(root, "another"))).rejects.toThrow("symlinks");
});

test("profiling setup generates repeatable inputs and keeps maintainer solutions out of workspaces", async () => {
  const first = await fixture({ task: "slow_trace_search" });
  const second = await fixture({ task: "slow_trace_search" });
  const manifest = await json(join(first.workspace, "data/MANIFEST.json"));
  expect(manifest.records).toBeGreaterThan(1000);
  expect(await json(join(second.workspace, "data/MANIFEST.json"))).toEqual(manifest);
  expect(await Bun.file(join(first.workspace, "maintainer/reference_fix.patch")).exists()).toBe(false);
  expect(await Bun.file(join(first.workspace, "verifier/verify.py")).exists()).toBe(false);
  expect(await Bun.file(join(first.workspace, "work/report.md")).exists()).toBe(false);
  expect(await capture(["git", "status", "--porcelain"], first.workspace)).toBe("");
});

test("search latency prepares reproducible diagnostic inputs without leaking its repair", async () => {
  const first = await fixture({ task: "search_latency", agent: "jive" });
  const second = await fixture({ task: "search_latency", agent: "jive" });
  const manifest = await json(join(first.workspace, "data/MANIFEST.json"));
  expect(manifest.records).toBe(18000);
  expect(await json(join(second.workspace, "data/MANIFEST.json"))).toEqual(manifest);
  expect(await Bun.file(join(first.workspace, "maintainer/DESIGN.md")).exists()).toBe(false);
  expect(await Bun.file(join(first.workspace, "maintainer/reference_fix.patch")).exists()).toBe(false);
  expect(await Bun.file(join(first.workspace, "verifier/verify.py")).exists()).toBe(false);
  expect(await readFile(join(first.workspace, "README.md"), "utf8")).toContain(OPENROUTER_NOTE);
  expect(await capture(["python3", "-m", "unittest", "discover", "-s", "tests"], first.workspace)).not.toBeNull();
  expect(await capture(["git", "status", "--porcelain"], first.workspace)).toBe("");
}, 15000);

test("headless runner preserves prompts as literal arguments, reports agent failure, and never equates exit zero with a grade", async () => {
  const root = await scratch(), executable = await fakeAgent(root);
  const promptFile = join(root, "prompt.txt");
  await writeFile(promptFile, "literal $(touch injected) `touch injected` quotes ' \" and\nnewlines");
  let run = await prepareRun({ task: "intent_routing", agent: "codex", headless: true, runsRoot: root, executable, promptFile });
  run = await executeRun(run.id, root);
  expect(run.status).toBe("completed");
  expect(run.grading.status).toBe("ungraded");
  expect((await json(join(run.workspace, "work/received.json"))).argv.at(-1)).toContain("$(touch injected)");
  expect(await Bun.file(join(run.workspace, "injected")).exists()).toBe(false);
  expect(await readFile(join(run.directory, "logs/agent.stdout.log"), "utf8")).toContain("fake.started");
  expect((await json(join(run.directory, "result.json"))).exitCode).toBe(0);
  await expect(executeRun(run.id, root)).rejects.toThrow("fresh run");
  let failure = await prepareRun({ task: "intent_routing", agent: "claude", headless: true, runsRoot: root, executable, extraArgs: ["--fail"] });
  failure = await executeRun(failure.id, root);
  expect(failure.status).toBe("failed");
  expect(failure.exitCode).toBe(7);
}, 15000);

test("detached run remains inspectable and stop terminates detached descendants", async () => {
  const root = await scratch(), executable = await fakeAgent(root);
  const run = await prepareRun({ task: "intent_routing", agent: "codex", headless: true, runsRoot: root, executable, extraArgs: ["--hold"] });
  await detachRun(run);
  await waitFor(() => Bun.file(join(run.workspace, "work/child.pid")).exists());
  expect((await runStatus(run.id, root)).status).toBe("running");
  expect(await logTail(run.id, root, 30)).toContain("fake.started");
  const descendant = Number(await readFile(join(run.workspace, "work/child.pid"), "utf8"));
  await stopRun(run.id, root);
  await waitFor(async () => (await readRun(run.id, root)).status === "cancelled");
  expect(await capture(["ps", "-p", String(descendant), "-o", "pid="], root)).toBeNull();
  expect((await json(join(run.directory, "result.json"))).status).toBe("cancelled");
}, 15000);

test("timeouts retain results and missing executables fail clearly", async () => {
  const root = await scratch(), executable = await fakeAgent(root);
  const run = await prepareRun({ task: "intent_routing", agent: "codex", headless: true, runsRoot: root, executable, extraArgs: ["--hold"], timeoutSeconds: .5 });
  expect((await executeRun(run.id, root)).status).toBe("timed_out");
  const missing = await prepareRun({ task: "intent_routing", agent: "codex", headless: true, runsRoot: root, executable: join(root, "absent") });
  const failed = await executeRun(missing.id, root);
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("ENOENT");
}, 15000);

async function oracle(run: RunRecord) {
  const reference = await json(join(run.definition, "verifier/reference.json"));
  const work = join(run.workspace, "work");
  await writeFile(join(work, "report.md"), "Oracle fixture for verifier tests; not an agent run.");
  if (run.task === "conversation_eval") {
    await jsonl(join(work, "predictions.jsonl"), reference.test_labels);
    await jsonl(join(work, "pair_predictions.jsonl"), reference.test_pairs);
    for (const round of ["r1", "r2", "r3"]) {
      await jsonl(join(work, `dev_predictions-${round}.jsonl`), reference.dev_labels);
      await jsonl(join(work, `dev_pair_predictions-${round}.jsonl`), reference.dev_pairs);
      await writeFile(join(work, `rubric-${round}.md`), "test rubric");
      await writeJSON(join(work, `score-dev-${round}.json`), {});
      await jsonl(join(work, `evidence-${round}.jsonl`), [{ source: "test fixture" }]);
    }
  } else {
    await jsonl(join(work, "predictions.jsonl"), reference.labels);
    if (run.task === "sembench_movie") {
      const labels = new Map<string, string>(reference.labels.map((r: any) => [r.id, r.sentiment]));
      const counts = Object.fromEntries(reference.queries.movies.map((movie: string) => [movie, reference.records.filter((r: any) => r.movie_id === movie && labels.get(r.id) === "positive").length]));
      await writeJSON(join(work, "movie_counts.json"), counts);
      await writeJSON(join(work, "movie_ranking.json"), Object.entries(counts).sort(([a, ac], [b, bc]) => Number(bc) - Number(ac) || a.localeCompare(b)).map(([movie_id, count]) => ({ movie_id, positive_fraction: Number(count) / 30 })));
      const records = reference.records.filter((r: any) => r.movie_id === reference.queries.pair_movie);
      const pairs = [];
      for (let i = 0; i < records.length && pairs.length < 10; i++) for (let j = i + 1; j < records.length && pairs.length < 10; j++) if (labels.get(records[i].id) === labels.get(records[j].id)) pairs.push({ a: records[i].id, b: records[j].id });
      await jsonl(join(work, "review_pairs.jsonl"), pairs);
    }
  }
}

test("all four verifiers accept correct artifacts and reject incomplete, duplicate, or modified-reference submissions", async () => {
  for (const task of (await listTasks()).filter(task => ["conversation_eval", "intent_routing", "product_matching", "sembench_movie"].includes(task.id))) {
    const run = await fixture({ task: task.id });
    expect((await verifyRun(run.id, resolve(run.directory, ".."))).grading.status).toBe("failed");
    await oracle(run);
    const passed = await verifyRun(run.id, resolve(run.directory, ".."));
    expect(passed.grading.status, await readFile(passed.grading.report!, "utf8")).toBe("passed");
    expect(passed.grading.attempts).toHaveLength(2);
    const path = join(run.workspace, "work/predictions.jsonl");
    const rows = (await readFile(path, "utf8")).trim().split("\n");
    await writeFile(path, rows[0] + "\n" + rows[0] + "\n");
    expect((await verifyRun(run.id, resolve(run.directory, ".."))).grading.status).toBe("failed");
    await writeFile(join(run.definition, "verifier/reference.json"), "{}");
    expect((await verifyRun(run.id, resolve(run.directory, ".."))).grading.status).toBe("error");
  }
}, 20000);

test("public dev scorer works using only workspace labels and rejects test scoring", async () => {
  const run = await fixture({ task: "product_matching" });
  const data = (await readFile(join(run.workspace, "data/dev.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  await jsonl(join(run.workspace, "work/dev_predictions.jsonl"), data.map(({ id, match }) => ({ id, match })));
  const output = await capture(["python3", join(run.workspace, "scripts/score.py")], run.workspace);
  expect(JSON.parse(output!).accuracy).toBe(1);
  expect(await capture(["python3", join(run.workspace, "scripts/score.py"), "--split", "test"], run.workspace)).toBeNull();
});

test("the real Jive launcher executes its offline demo through the headless adapter", async () => {
  const run = await fixture({ agent: "jive", extraArgs: ["--demo"] });
  const completed = await executeRun(run.id, resolve(run.directory, ".."));
  expect(completed.status, completed.error).toBe("completed");
  expect(completed.grading.status).toBe("ungraded");
  expect(await readFile(join(run.directory, "logs/agent.stdout.log"), "utf8")).toContain("graph.finished");
}, 15000);

test("CLI JSON output is parseable and invalid run paths are rejected", async () => {
  const cli = resolve(import.meta.dir, "../bin/taskground.ts");
  const result = await capture([process.execPath, cli, "list", "--json"], resolve(import.meta.dir, ".."));
  expect(JSON.parse(result!)).toHaveLength((await listTasks()).length);
  await expect(readRun("../escape")).rejects.toThrow("Invalid run ID");
});

test("interactive adapters never auto-submit the task, while headless adapters still submit it", () => {
  const command = agentCommand({ agent: "jive", workspace: "/tmp/with spaces", prompt: "hello", headless: false, finalPath: "/tmp/final" });
  expect(command[0]).toBe(resolve(import.meta.dir, "../bin/jive"));
  expect(command).not.toContain("--headless");
  expect(command).toContain("--prefill");
  expect(command).not.toContain("--prompt");
  const headless = agentCommand({ agent: "jive", workspace: "/tmp/with spaces", prompt: "hello", headless: true, finalPath: "/tmp/final" });
  expect(headless).toContain("--prompt");
  expect(headless).not.toContain("--prefill");
  for (const agent of ["claude", "codex"] as const) {
    const options = { agent, workspace: "/tmp/with spaces", prompt: "--literal draft\nsecond line", finalPath: "/tmp/final" };
    const interactive = agentCommand({ ...options, headless: false });
    expect(interactive).not.toContain("--print");
    expect(interactive).not.toContain("exec");
    if (agent === "claude") expect(interactive.slice(-2)).toEqual(["--prefill", options.prompt]);
    else expect(interactive).not.toContain(options.prompt);
    const unattended = agentCommand({ ...options, headless: true });
    expect(unattended.at(-1)).toBe(options.prompt);
    expect(unattended).not.toContain("--prefill");
    expect(unattended).toContain(agent === "claude" ? "--print" : "exec");
  }
});

test("Jive rejects draft-prefill options in headless mode before doing any work", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.tsx"), "--demo", "--headless", "--prefill", "Do not submit"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("--prefill is interactive-only");
});

test("status identifies a dead supervisor without signalling a recycled PID", async () => {
  const run = await fixture();
  run.status = "running"; run.runnerPid = process.pid; run.runnerStarted = "a different process start";
  await writeJSON(join(run.directory, "run.json"), run);
  const status = await runStatus(run.id, resolve(run.directory, ".."));
  expect(status.status).toBe("failed");
  expect(status.error).toContain("supervisor");
});
