import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENTS, OPENROUTER_NOTE, agentCommand, type Agent } from "./agents";
import { DEFINITIONS, RUNS, SHARED, REPO_ROOT, ID, copyDefinition, fingerprint, loadTask, writeJSON } from "./tasks";
import { capture, runProcess } from "./process";

export interface RunOptions {
  task: string; agent: Agent; headless?: boolean; model?: string; executable?: string; extraArgs?: string[];
  promptFile?: string; envFile?: string; timeoutSeconds?: number; runsRoot?: string; definitionDir?: string;
}
export type RunStatus = "preparing" | "ready" | "starting" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
export interface RunRecord {
  schemaVersion: 1; id: string; task: string; agent: Agent; mode: "interactive" | "headless"; status: RunStatus;
  createdAt: string; startedAt?: string; finishedAt?: string; elapsedMs?: number;
  directory: string; workspace: string; definition: string; definitionHash?: string;
  source: { directory: string; revision: string | null; dirty: boolean; codeHash: string };
  model?: string; executable?: string; extraArgs: string[]; timeoutSeconds?: number; command?: string[];
  runnerPid?: number; runnerStarted?: string | null; agentPid?: number; agentVersion?: string | null; envFile?: string;
  exitCode?: number | null; signal?: string | null; error?: string; sessionArtifacts?: string[];
  grading: { status: "ungraded" | "passed" | "failed" | "error"; report?: string; attempts?: string[] };
}

const terminal = new Set<RunStatus>(["completed", "failed", "cancelled", "timed_out"]);
const credentialNames = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "JEV_API_TOKEN", "TYPESAFE_API_KEY", "JEV_MODEL"];

export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2]!.trim();
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try { values[match[1]!] = JSON.parse(raw); } catch { values[match[1]!] = raw.slice(1, -1); }
    } else values[match[1]!] = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw.replace(/\s+#.*$/, "").trim();
  }
  return values;
}

async function credentials(envFile?: string): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  const common = await capture(["git", "rev-parse", "--git-common-dir"], REPO_ROOT);
  const paths = envFile ? [resolve(envFile)] : [join(REPO_ROOT, ".env"), ...(common ? [join(dirname(resolve(REPO_ROOT, common)), ".env")] : [])];
  for (const path of [...new Set(paths)]) {
    let content: string;
    try { content = await readFile(path, "utf8"); } catch (error) { if (envFile) throw error; continue; }
    const values = parseDotEnv(content);
    for (const key of credentialNames) if (env[key] === undefined && values[key] !== undefined) env[key] = values[key];
  }
  return env;
}

async function save(run: RunRecord) { await writeJSON(join(run.directory, "run.json"), run); }
async function processStarted(pid: number) { return await capture(["ps", "-p", String(pid), "-o", "lstart="], REPO_ROOT); }
export function runDirectory(id: string, root = RUNS) {
  if (!ID.test(id)) throw new Error("Invalid run ID");
  return join(resolve(root), id);
}
export async function readRun(id: string, root = RUNS): Promise<RunRecord> {
  const directory = runDirectory(id, root);
  const run = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as RunRecord;
  if (run.id !== id || run.directory !== directory || run.workspace !== join(directory, "workspace") || run.definition !== join(directory, "definition")) throw new Error("Run paths do not match this run directory");
  return run;
}

export async function runStatus(id: string, root = RUNS): Promise<RunRecord> {
  const run = await readRun(id, root);
  if (["running", "starting"].includes(run.status) && run.runnerPid && run.runnerStarted && await processStarted(run.runnerPid) !== run.runnerStarted) {
    // It may have finished while ps was running. Never overwrite its final result.
    const latest = await readRun(id, root);
    if (terminal.has(latest.status) || latest.runnerPid !== run.runnerPid || latest.runnerStarted !== run.runnerStarted) return latest;
    run.status = "failed";
    run.error = "The run supervisor exited unexpectedly; inspect logs and retained artifacts";
    run.finishedAt = new Date().toISOString();
    await save(run);
    await writeJSON(join(run.directory, "result.json"), run);
  }
  return run;
}

function hook(command: string[], run: RunRecord, result: string): string[] {
  return command.map(arg => arg.replaceAll("{workspace}", run.workspace).replaceAll("{definition}", run.definition).replaceAll("{result}", result));
}

export async function prepareRun(options: RunOptions): Promise<RunRecord> {
  if (!AGENTS.includes(options.agent)) throw new Error(`Unknown agent: ${options.agent}`);
  if (!ID.test(options.task)) throw new Error("Invalid task ID");
  if (options.timeoutSeconds !== undefined && (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0)) throw new Error("Timeout must be a positive number of seconds");
  const source = options.definitionDir ?? join(DEFINITIONS, options.task);
  const task = await loadTask(source);
  if (task.id !== options.task) throw new Error("Task ID does not match its manifest");
  const env = await credentials(options.envFile);
  const id = `${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "")}-${task.id}-${randomUUID().slice(0, 8)}`;
  const directory = runDirectory(id, options.runsRoot);
  const run: RunRecord = {
    schemaVersion: 1, id, task: task.id, agent: options.agent, mode: options.headless ? "headless" : "interactive", status: "preparing",
    createdAt: new Date().toISOString(), directory, workspace: join(directory, "workspace"), definition: join(directory, "definition"),
    source: { directory: REPO_ROOT, revision: await capture(["git", "rev-parse", "HEAD"], REPO_ROOT), dirty: Boolean(await capture(["git", "status", "--porcelain"], REPO_ROOT)), codeHash: await fingerprint(join(REPO_ROOT, "src")) },
    model: options.model, executable: options.executable, extraArgs: options.extraArgs ?? [], timeoutSeconds: options.timeoutSeconds,
    grading: { status: "ungraded" },
    envFile: options.envFile ? resolve(options.envFile) : undefined,
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await mkdir(join(directory, "logs"));
  await save(run);
  try {
    await copyDefinition(source, run.definition);
    await copyDefinition(SHARED, join(run.definition, "_shared"));
    run.definitionHash = await fingerprint(run.definition);
    await copyDefinition(join(run.definition, "workspace"), run.workspace);
    await mkdir(join(run.workspace, "work"), { recursive: true });
    const ignore = "\n.env\n.env.*\n.jev/\n.context/\n.cache/\n__pycache__/\nwork/\n";
    await appendFile(join(run.workspace, ".gitignore"), ignore);
    // Only the requested helper key is persisted; Jive's other credentials travel in its environment.
    await writeFile(join(run.workspace, ".env"), `OPENROUTER_API_KEY=${JSON.stringify(env.OPENROUTER_API_KEY ?? "")}\n`, { mode: 0o600 });
    // Task context is identical across agent profiles; only native adapters differ.
    await appendFile(join(run.workspace, "README.md"), `\n\n${OPENROUTER_NOTE}\n`);
    const instruction = options.promptFile ? await readFile(resolve(options.promptFile), "utf8") : await readFile(join(run.definition, "instruction.md"), "utf8");
    const prompt = `${instruction.trim()}\n\nRead README.md for the task environment and available resources. Work in this directory and preserve your deliverables under work/.`;
    await writeFile(join(directory, "prompt.txt"), prompt + "\n");
    await writeFile(join(run.workspace, "TASK.md"), instruction);
    if (task.setup) {
      const result = await runProcess(hook(task.setup, run, join(directory, "setup.json")), { cwd: run.workspace, env, stdout: join(directory, "logs/setup.stdout.log"), stderr: join(directory, "logs/setup.stderr.log") });
      if (result.exitCode !== 0) throw new Error("Task setup failed; inspect logs/setup.stderr.log");
    }
    for (const args of [["init", "--quiet"], ["add", "--all"], ["-c", "user.name=Taskground", "-c", "user.email=taskground@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Task starting state"]]) {
      const result = await capture(["git", "-c", "core.hooksPath=/dev/null", ...args], run.workspace);
      if (result === null) throw new Error("Could not initialize the task workspace Git repository");
    }
    run.status = "ready";
    await save(run);
    return run;
  } catch (error) {
    run.status = "failed"; run.error = error instanceof Error ? error.message : String(error); run.finishedAt = new Date().toISOString();
    await save(run); await writeJSON(join(directory, "result.json"), run);
    throw new Error(`${run.error}. Run retained at ${directory}`);
  }
}

export async function executeRun(id: string, root = RUNS): Promise<RunRecord> {
  const run = await readRun(id, root);
  if (!["ready", "starting"].includes(run.status)) throw new Error(`Run is ${run.status}; create a fresh run to try again`);
  const lock = await open(join(run.directory, "execution.lock"), "wx", 0o600);
  await lock.close();
  run.runnerPid = process.pid; run.runnerStarted = await processStarted(process.pid); run.startedAt = new Date().toISOString(); run.status = "running";
  await save(run);
  try {
    const env = await credentials(run.envFile);
    Object.assign(env, parseDotEnv(await readFile(join(run.workspace, ".env"), "utf8")));
    const prompt = await readFile(join(run.directory, "prompt.txt"), "utf8");
    run.command = agentCommand({ agent: run.agent, workspace: run.workspace, prompt, headless: run.mode === "headless", model: run.model, executable: run.executable, extraArgs: run.extraArgs, finalPath: join(run.directory, "logs/final.txt") });
    if (run.agent === "jive" && !env.OPENROUTER_API_KEY && !run.extraArgs.includes("--demo")) throw new Error("Jive requires OPENROUTER_API_KEY; set it in the shell or repository .env before preparing the run");
    run.agentVersion = run.agent === "jive" ? JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")).version : await capture([run.command[0]!, "--version"], run.workspace);
    const result = await runProcess(run.command, {
      cwd: run.workspace, env, interactive: run.mode === "interactive", cancelFile: join(run.directory, "cancel.requested"),
      stdout: join(run.directory, "logs/agent.stdout.log"), stderr: join(run.directory, "logs/agent.stderr.log"),
      timeoutMs: run.timeoutSeconds ? run.timeoutSeconds * 1000 : undefined,
      onStart: async pid => { run.agentPid = pid; await save(run); },
    });
    run.exitCode = result.exitCode; run.signal = result.signal;
    run.status = result.timedOut ? "timed_out" : result.cancelled ? "cancelled" : result.exitCode === 0 ? "completed" : "failed";
    if (run.agent === "jive") {
      const sessions = join(run.workspace, ".jev/sessions");
      const entries = await readdir(sessions, { withFileTypes: true }).catch(() => []);
      run.sessionArtifacts = entries.filter(e => e.isDirectory()).map(e => join(sessions, e.name, "session.jsonl"));
    }
  } catch (error) {
    run.status = "failed"; run.error = error instanceof Error ? error.message : String(error);
  }
  run.finishedAt = new Date().toISOString();
  run.elapsedMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt!);
  await save(run);
  await writeJSON(join(run.directory, "result.json"), run);
  return run;
}

export async function detachRun(run: RunRecord): Promise<RunRecord> {
  run.status = "starting";
  await save(run);
  const log = await open(join(run.directory, "logs/runner.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [join(REPO_ROOT, "bin/taskground.ts"), "_execute", run.id, "--runs-dir", dirname(run.directory)], { cwd: REPO_ROOT, detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    // The worker owns run.json from this point onward; do not race it with another write.
    return { ...run, runnerPid: child.pid };
  } catch (error) {
    run.status = "failed"; run.error = error instanceof Error ? error.message : String(error); run.finishedAt = new Date().toISOString();
    await save(run); await writeJSON(join(run.directory, "result.json"), run);
    throw error;
  } finally { await log.close(); }
}

export async function stopRun(id: string, root = RUNS): Promise<RunRecord> {
  const run = await runStatus(id, root);
  if (terminal.has(run.status)) return run;
  if (run.status === "ready") throw new Error("This workspace was only prepared; no agent is running");
  await writeFile(join(run.directory, "cancel.requested"), new Date().toISOString());
  return run;
}

export async function verifyRun(id: string, root = RUNS): Promise<RunRecord> {
  const run = await runStatus(id, root);
  if (!terminal.has(run.status) && run.status !== "ready") throw new Error("Wait for the agent to stop before verifying its artifacts");
  const task = await loadTask(run.definition);
  if (!task.verify) return run;
  const result = join(run.directory, "verification", `${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await mkdir(dirname(result), { recursive: true });
  run.grading.attempts = [...run.grading.attempts ?? [], result];
  try {
    if (await fingerprint(run.definition) !== run.definitionHash) throw new Error("The saved task definition or verifier changed after preparation");
    const processResult = await runProcess(hook(task.verify, run, result), { cwd: run.workspace, stdout: `${result}.stdout.log`, stderr: `${result}.stderr.log`, env: { ...process.env, TASKGROUND_WORKSPACE: run.workspace, TASKGROUND_DEFINITION: run.definition, TASKGROUND_RESULT: result }, timeoutMs: 60000 });
    const report = JSON.parse(await readFile(result, "utf8"));
    if (!["passed", "failed"].includes(report.status) || !report.checks || processResult.exitCode !== (report.status === "passed" ? 0 : 1)) throw new Error("Verifier failed or returned an invalid report; inspect verification logs");
    run.grading = { status: report.status, report: result, attempts: run.grading.attempts };
  } catch (error) {
    await writeJSON(result, { status: "error", error: error instanceof Error ? error.message : String(error) });
    run.grading = { status: "error", report: result, attempts: run.grading.attempts };
  }
  await save(run);
  await writeJSON(join(run.directory, "result.json"), run);
  return run;
}

export async function logTail(id: string, root = RUNS, lines = 40): Promise<string> {
  const run = await readRun(id, root);
  const files = ["agent.stdout.log", "agent.stderr.log", "runner.log"];
  const output: string[] = [];
  for (const name of files) {
    const path = join(run.directory, "logs", name);
    try {
      const file = await open(path, "r");
      try {
        const { size } = await file.stat();
        const buffer = Buffer.alloc(Math.min(size, 256000));
        await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        if (buffer.length) output.push(`${name}\n${buffer.toString().trimEnd().split("\n").slice(-lines).join("\n")}`);
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return output.join("\n\n") || `No captured output yet. Interactive runs use the terminal; native session artifacts are recorded in run.json.\nWorkspace: ${run.workspace}`;
}
