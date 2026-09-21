#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { listTasks } from "../taskground/app/tasks";
import { AGENTS, type Agent } from "../taskground/app/agents";
import { prepareRun, executeRun, scheduleRun, executeScheduledRun, runStatus, stopRun, verifyRun, logTail, type RunRecord, type RunOptions } from "../taskground/app/runner";
import { defaultRunsRoot, listRuns, locateRun } from "../taskground/app/storage";
import { type SourceMode } from "../taskground/app/source";

const HELP = `Taskground — fresh, retained workspaces for agent tasks

  bun run taskground launch [--port 4317] [--no-open]
  bun run taskground list [--json]
  bun run taskground runs [--json]
  bun run taskground prepare TASK --agent jive|codex|claude [--json]
  bun run taskground run TASK --agent jive|codex|claude
  bun run taskground run TASK --agent jive|codex|claude --headless [--detach] [--json]
  bun run taskground run TASK --agent jive|codex|claude --terminal [--json]
  bun run taskground status RUN_ID [--json]
  bun run taskground logs RUN_ID [--tail 40]
  bun run taskground stop RUN_ID [--json]
  bun run taskground verify RUN_ID [--json]
  bun run taskground export RUN_ID

Options: --model ID --effort LEVEL --prompt-file FILE --env-file FILE --timeout SECONDS
         --agent-bin PATH --agent-arg=ARG (repeatable) --runs-dir DIR
Source:  --source working|head|commit [--commit REVISION] (default: working)
Video:   --record [--width 1920 --height 1080 --columns 120 --rows 36]

launch opens a local browser dashboard with native agent terminals. Headless CLI
runs also appear automatically; local interactive runs are excluded.
--terminal starts a detached native agent session; view and attach in the browser.
Source is snapshotted from the primary worktree.
New runs live outside the repo; TASKGROUND_DATA_DIR overrides the data directory.
--record captures the headless transcript; export renders an MP4 using FFmpeg.

Interactive runs open in the current terminal without submitting a task. Jive and
Claude prefill an editable draft; in Codex, ask it to read TASK.md and README.md.
--headless waits; --detach returns a run ID immediately. status and logs work while
a headless run is active. --json keeps stdout machine-readable (agent output goes to
logs). A completed process is ungraded until verify runs. There is no enforced
API-call or spend limit; all READMEs state the same 200-call helper allowance.
The bundled task preparation and verifiers make no model calls.
`;

function summary(run: RunRecord) {
  return { id: run.id, task: run.task, agent: run.agent, model: run.model, effort: run.effort, mode: run.mode, status: run.status, grading: run.grading, elapsedMs: run.elapsedMs, source: run.source, recording: run.recording, workspace: run.workspace, run: `${run.directory}/run.json`, result: `${run.directory}/result.json`, logs: `${run.directory}/logs`, error: run.error };
}

async function main() {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, json: { type: "boolean" }, agent: { type: "string", default: "jive" },
    headless: { type: "boolean" }, terminal: { type: "boolean" }, detach: { type: "boolean" }, model: { type: "string" }, effort: { type: "string" },
    "prompt-file": { type: "string" }, "env-file": { type: "string" }, timeout: { type: "string" },
    "agent-bin": { type: "string" }, "agent-arg": { type: "string", multiple: true },
    "runs-dir": { type: "string" }, tail: { type: "string", default: "40" },
    source: { type: "string" }, commit: { type: "string" },
    port: { type: "string" }, "no-open": { type: "boolean" }, record: { type: "boolean" },
    width: { type: "string", default: "1920" }, height: { type: "string", default: "1080" },
    columns: { type: "string", default: "120" }, rows: { type: "string", default: "36" },
  } });
  const [command, id] = positionals;
  if (values.help || !command) { console.log(HELP); return; }
  let root = values["runs-dir"] ? resolve(values["runs-dir"]) : await defaultRunsRoot();
  const print = (run: RunRecord) => {
    if (values.json || command === "_execute") console.log(JSON.stringify(summary(run)));
    else console.log(`${run.id}\n${run.status} / ${run.grading.status}\nWorkspace: ${run.workspace}\nRun: ${run.directory}${run.error ? `\nError: ${run.error}` : ""}`);
  };
  if (command === "list") {
    const tasks = await listTasks();
    console.log(values.json ? JSON.stringify(tasks) : tasks.map(t => `${t.id.padEnd(20)} ${t.description}`).join("\n"));
    return;
  }
  if (command === "launch") {
    if (id) throw new Error("launch takes no task ID");
    const port = values.port === undefined ? 4317 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535");
    const { startDashboard } = await import("../taskground/app/server");
    const { url, server } = await startDashboard({ port, runsRoot: root, open: !values["no-open"] });
    console.log(`Taskground ${url}\nManaged terminal and detached headless runs continue when this dashboard closes.`);
    const close = () => { server.stop(true); process.exit(0); };
    process.once("SIGINT", close); process.once("SIGTERM", close);
    return;
  }
  if (command === "runs") {
    const runs = await listRuns(root);
    console.log(values.json ? JSON.stringify(runs.map(summary)) : runs.map(run => `${run.id}  ${run.agent.padEnd(6)} ${run.status.padEnd(10)} ${run.grading.status}`).join("\n") || "No managed runs yet.");
    return;
  }
  if (!id || positionals.length > 2) throw new Error("Provide exactly one task or run ID; see --help");
  if (command === "run" || command === "prepare") {
    if (!AGENTS.includes(values.agent as Agent)) throw new Error(`Choose an agent: ${AGENTS.join(", ")}`);
    if (values.terminal && values.headless) throw new Error("Choose --terminal or --headless");
    if (values.detach && !values.headless && !values.terminal) throw new Error("--detach requires --headless or --terminal");
    if (command === "run" && !values.headless && !values.terminal && values.json) throw new Error("Interactive terminal output cannot be JSON; use --headless --json or --terminal --json");
    if (command === "run" && !values.headless && !values.terminal && !process.stdin.isTTY) throw new Error("Interactive runs need a terminal; use --headless, --terminal or prepare");
    const options: RunOptions = { task: id, agent: values.agent as Agent, headless: values.headless, terminal: values.terminal, model: values.model, effort: values.effort, executable: values["agent-bin"], extraArgs: values["agent-arg"], promptFile: values["prompt-file"], envFile: values["env-file"], timeoutSeconds: values.timeout === undefined ? undefined : Number(values.timeout), runsRoot: root, sourceMode: (values.source ?? (values.commit ? "commit" : "working")) as SourceMode, commit: values.commit, recording: values.record ? { width: Number(values.width), height: Number(values.height), columns: Number(values.columns), rows: Number(values.rows) } : undefined };
    if (command === "run" && (values.detach || values.terminal)) { print(await scheduleRun(options)); return; }
    let run = await prepareRun(options);
    if (command === "prepare") { print(run); return; }
    if (!values.json) console.error(`Run ${run.id}\nWorkspace: ${run.workspace}`);
    if (!values.headless && run.agent === "codex") console.error("Codex opens without submitting a prompt. To start, enter: Read TASK.md and README.md, then complete the task.\nThe full prepared prompt is in ../prompt.txt.");
    run = await executeRun(run.id, root);
    print(run);
    if (["failed", "cancelled", "timed_out"].includes(run.status)) process.exitCode = 1;
    return;
  }
  if (!["_execute", "_start"].includes(command)) root = (await locateRun(id, values["runs-dir"] ? root : undefined)).root;
  if (command === "_start") { const run = await executeScheduledRun(id, root); print(run); if (run.status !== "completed") process.exitCode = 1; return; }
  if (command === "export") {
    const { exportRecording } = await import("../taskground/app/recording");
    const path = await exportRecording(await runStatus(id, root));
    console.log(values.json ? JSON.stringify({ path }) : path); return;
  }
  if (command === "logs") {
    const lines = Number(values.tail);
    if (!Number.isInteger(lines) || lines < 1 || lines > 10000) throw new Error("--tail must be between 1 and 10000");
    console.log(await logTail(id, root, lines)); return;
  }
  if (command === "status") {
    const run = await runStatus(id, root);
    if (values.json && run.mode !== "interactive") {
      const { getRunMetrics } = await import("../taskground/app/metrics");
      console.log(JSON.stringify({ ...summary(run), metrics: await getRunMetrics(run) }));
    } else print(run);
    return;
  }
  if (command === "stop") { print(await stopRun(id, root)); return; }
  if (command === "verify") {
    const run = await verifyRun(id, root); print(run);
    if (["failed", "error"].includes(run.grading.status)) process.exitCode = 1;
    return;
  }
  if (command === "_execute") { const run = await executeRun(id, root); print(run); if (run.status !== "completed") process.exitCode = 1; return; }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
