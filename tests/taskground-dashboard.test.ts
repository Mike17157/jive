import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDashboard } from "../taskground/app/server";
import { writeJSON } from "../taskground/app/tasks";
import { listRuns, registerRunsRoot } from "../taskground/app/storage";
import { readRun, stopRun, scheduleRun } from "../taskground/app/runner";

const scratch: string[] = [];
const servers: Awaited<ReturnType<typeof startDashboard>>[] = [];
const originalData = process.env.TASKGROUND_DATA_DIR;
afterEach(async () => {
  for (const instance of servers.splice(0)) instance.server.stop(true);
  if (originalData === undefined) delete process.env.TASKGROUND_DATA_DIR; else process.env.TASKGROUND_DATA_DIR = originalData;
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const data = await mkdtemp(join(tmpdir(), "taskground-dashboard-")); scratch.push(data);
  process.env.TASKGROUND_DATA_DIR = data;
  const root = join(data, "custom-runs"); await mkdir(root);
  await registerRunsRoot(root);
  const instance = await startDashboard({ port: 0, runsRoot: root, open: false }); servers.push(instance);
  return { data, root, ...instance };
}
async function savedRun(root: string, id: string, mode = "headless", status = "completed") {
  const directory = join(root, id); await mkdir(join(directory, "workspace/work"), { recursive: true });
  await mkdir(join(directory, "logs"));
  await writeJSON(join(directory, "run.json"), {
    schemaVersion: 1, id, directory, workspace: join(directory, "workspace"), definition: join(directory, "definition"),
    task: "intent_routing", agent: "codex", mode, status, createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:02.000Z", elapsedMs: 2000,
    source: { directory: root, revision: "abc", dirty: false, codeHash: "fixture" }, grading: { status: "ungraded" }, extraArgs: [],
  });
  return directory;
}

test("dashboard discovers registered CLI headless history, excludes interactive runs and survives reconnect", async () => {
  const { url, root } = await setup();
  const dir = await savedRun(root, "cli-history");
  await savedRun(root, "interactive-history", "interactive");
  await savedRun(root, "terminal-history", "terminal");
  await writeFile(join(dir, "logs/agent.stdout.log"), 'hello from a CLI run\n');
  expect((await listRuns()).some(run => run.id === "cli-history")).toBe(true);
  const response = await fetch(url + "/api/state"); expect(response.status).toBe(200);
  const state = await response.json() as any;
  expect(state.runs.some((run: any) => run.id === "cli-history")).toBe(true);
  expect(state.runs.some((run: any) => run.id === "interactive-history")).toBe(false);
  expect(state.runs.some((run: any) => run.id === "terminal-history")).toBe(true);
  expect(state.tasks.length).toBeGreaterThan(0);
  expect((await (await fetch(url + "/api/runs/cli-history/output")).json() as any).text).toContain("hello from a CLI run");
  const next = await startDashboard({ port: 0, runsRoot: root, open: false }); servers.push(next);
  expect((await (await fetch(next.url + "/api/runs/cli-history")).json() as any).id).toBe("cli-history");
});

test("native terminal API authenticates viewers and restores completed screens", async () => {
  const { url, root } = await setup();
  const directory = await savedRun(root, "terminal-screen", "terminal");
  await writeJSON(join(directory, "terminal-screen.json"), { data: "\u001b[32mActual agent screen\u001b[0m", cols: 90, rows: 30 });
  const endpoint = url + "/api/runs/terminal-screen/terminal";
  expect((await fetch(endpoint)).status).toBe(403);
  const { token } = await (await fetch(url + "/api/config")).json() as any;
  const headers = { "Sec-WebSocket-Protocol": `taskground, ${token}`, Origin: "https://foreign.example" };
  expect((await fetch(endpoint, { headers })).status).toBe(403);
  const messages: any[] = [];
  const socket = new WebSocket(endpoint.replace("http:", "ws:"), ["taskground", token]);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Terminal snapshot timed out")); }, 3000);
    socket.onmessage = event => messages.push(JSON.parse(String(event.data)));
    socket.onerror = () => { clearTimeout(timer); reject(new Error("Terminal connection failed")); };
    socket.onclose = () => { clearTimeout(timer); resolve(); };
  });
  expect(messages[0]).toEqual({ type: "snapshot", data: "\u001b[32mActual agent screen\u001b[0m", cols: 90, rows: 30 });
  expect(messages[1].type).toBe("exit");
  expect((await fetch(url + "/xterm.js")).status).toBe(200);
  expect((await fetch(url + "/xterm.css")).status).toBe(200);
});

test("default dashboard launch owns a real terminal and survives dashboard restart with input detached", async () => {
  const { url, root, data, server } = await setup();
  const bin = join(data, "native-bin"); await mkdir(bin);
  await writeFile(join(bin, "codex"), `#!${process.execPath}
if(process.argv.includes('--version')){console.log('offline-native-test-agent');process.exit(0);}
const fs = require('node:fs');
fs.writeFileSync('native-start.json',JSON.stringify({tty:process.stdin.isTTY,args:process.argv}));
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HNative agent ready');
const path = require('node:path');
const rolloutDir = path.join(process.env.CODEX_HOME,'sessions',new Date().toISOString().slice(0,10).replaceAll('-','/'));
fs.mkdirSync(rolloutDir,{recursive:true});
const stamp = new Date().toISOString();
fs.writeFileSync(path.join(rolloutDir,'fixture.jsonl'),[
 {type:'session_meta',timestamp:stamp,payload:{cwd:process.cwd(),source:'cli'}},
 {type:'event_msg',timestamp:stamp,payload:{type:'task_started',turn_id:'initial'}},
 {type:'event_msg',timestamp:stamp,payload:{type:'task_complete',turn_id:'initial'}}
].map(value=>JSON.stringify(value)).join('\\n')+'\\n');
process.stdin.on('data',data=>{fs.appendFileSync('native-input.txt',data);process.stdout.write('\\r\\nreceived:'+data);});
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const previousPath = process.env.PATH; process.env.PATH = bin + ":" + previousPath;
  const previousCodexHome = process.env.CODEX_HOME; process.env.CODEX_HOME = join(data, "codex-home");
  let id: string | undefined;
  const sockets: WebSocket[] = [];
  const waitFor = async (check: () => boolean | Promise<boolean>) => {
    const until = Date.now() + 12000;
    while (!await check()) { if (Date.now() > until) throw new Error("Timed out waiting for native test agent"); await Bun.sleep(40); }
  };
  const connect = async (base: string, token: string) => {
    const messages: any[] = [];
    const socket = new WebSocket(base.replace("http:", "ws:") + `/api/runs/${id}/terminal`, ["taskground", token]); sockets.push(socket);
    socket.onmessage = event => messages.push(JSON.parse(String(event.data)));
    await waitFor(() => messages.some(message => message.type === "snapshot") && messages.some(message => typeof message.data === "string" && message.data.includes("Native agent ready")));
    return { socket, messages };
  };
  try {
    const { token } = await (await fetch(url + "/api/config")).json() as any;
    const response = await fetch(url + "/api/runs", { method: "POST", headers: { "Content-Type": "application/json", "X-Taskground-Token": token }, body: JSON.stringify({ task: "intent_routing", agent: "codex" }) });
    const body = await response.json() as any; expect(response.status, JSON.stringify(body)).toBe(202); id = body.id;
    await waitFor(async () => await Bun.file(join(root, id!, "workspace/native-start.json")).exists());
    const run = await readRun(id!, root); expect(run.mode).toBe("terminal");
    const start = await Bun.file(join(run.workspace, "native-start.json")).json();
    expect(start.tty).toBe(true); expect(start.args).not.toContain("exec"); expect(start.args.at(-1)).toContain("Read README.md");
    const first = await connect(url, token);
    const taskState = await (await fetch(url + `/api/runs/${id}`)).json() as any;
    expect(taskState.status).toBe("completed"); expect(taskState.processStatus).toBe("running");
    await Bun.sleep(100);
    expect((await (await fetch(url + `/api/runs/${id}`)).json() as any).elapsedMs).toBe(taskState.elapsedMs);
    const verified = await (await fetch(url + `/api/runs/${id}/verify`, { method: "POST", headers: { "Content-Type": "application/json", "X-Taskground-Token": token }, body: "{}" })).json() as any;
    expect(verified.grading.status).toBe("failed");
    expect(verified.status).toBe("completed"); expect(verified.processStatus).toBe("running");
    expect((await readRun(id!, root)).status).toBe("running");
    first.socket.send(JSON.stringify({ type: "input", data: "forbidden" }));
    await Bun.sleep(100);
    expect(await Bun.file(join(run.workspace, "native-input.txt")).exists()).toBe(false);
    first.socket.send(JSON.stringify({ type: "attach" }));
    await waitFor(() => first.messages.some(message => message.type === "control" && message.attached));
    first.socket.send(JSON.stringify({ type: "input", data: "hello" }));
    await waitFor(async () => await Bun.file(join(run.workspace, "native-input.txt")).exists());
    expect(await Bun.file(join(run.workspace, "native-input.txt")).text()).toBe("hello");
    server.stop(true);
    await waitFor(() => first.socket.readyState === WebSocket.CLOSED);
    const next = await startDashboard({ port: 0, runsRoot: root, open: false }); servers.push(next);
    const nextConfig = await (await fetch(next.url + "/api/config")).json() as any;
    const second = await connect(next.url, nextConfig.token);
    await waitFor(() => second.messages.some(message => message.type === "control" && message.attached === false));
    expect((await readRun(id!, root)).status).toBe("running");
    second.socket.send(JSON.stringify({ type: "attach" }));
    await waitFor(() => second.messages.some(message => message.type === "control" && message.attached));
    second.socket.send(JSON.stringify({ type: "input", data: "again" }));
    await waitFor(async () => (await Bun.file(join(run.workspace, "native-input.txt")).text()) === "helloagain");
  } finally {
    process.env.PATH = previousPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    for (const socket of sockets) socket.close();
    if (id) {
      await stopRun(id, root); await waitFor(async () => ["cancelled", "failed", "completed"].includes((await readRun(id!, root)).status));
      expect((await readRun(id!, root)).grading.status).toBe("failed");
    }
  }
}, 30000);

test("local API rejects foreign origins, invalid tokens, host rebinding and interactive mutations", async () => {
  const { url, root } = await setup();
  await savedRun(root, "done"); await savedRun(root, "interactive", "interactive");
  const { token } = await (await fetch(url + "/api/config")).json() as any;
  const endpoint = url + "/api/runs/done/stop";
  expect((await fetch(endpoint, { method: "POST" })).status).toBe(403);
  expect((await fetch(url + "/api/config", { headers: { Origin: "https://malicious.example" } })).status).toBe(403);
  expect((await fetch(url + "/api/state", { headers: { Host: "malicious.example" } })).status).toBe(403);
  const options = { method: "POST", headers: { "Content-Type": "application/json", "X-Taskground-Token": token }, body: "{}" };
  expect((await fetch(endpoint, options)).status).toBe(200);
  expect((await fetch(url + "/api/runs/interactive/stop", options)).status).toBe(404);
  expect((await fetch(url + "/api/runs", { ...options, body: JSON.stringify({ task: "intent_routing", agent: "unknown" }) })).status).toBe(400);
});

test("artifact downloads are confined to work outputs and reports remain explicit", async () => {
  const { url, root } = await setup(); const dir = await savedRun(root, "artifacts");
  await writeFile(join(dir, "workspace/work/result.txt"), "deliverable");
  await writeFile(join(dir, "workspace/.env"), "private");
  expect(await (await fetch(url + "/api/runs/artifacts/artifact?path=result.txt")).text()).toBe("deliverable");
  expect((await fetch(url + "/api/runs/artifacts/artifact?path=../.env")).status).toBe(403);
  expect((await fetch(url + "/api/runs/artifacts/report")).status).toBe(404);
  expect((await (await fetch(url + "/api/runs/artifacts/artifacts")).json() as any).files).toEqual([{ path: "result.txt", bytes: 11 }]);
});

test("API starts a retained headless agent that survives dashboard closure and can be cancelled and verified", async () => {
  const { url, root, data, server } = await setup();
  const bin = join(data, "bin"); await mkdir(bin);
  await writeFile(join(bin, "codex"), `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('offline-test-agent');process.exit(0);}console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{id:'one',type:'command_execution',command:'offline fixture',exit_code:0}}));setInterval(()=>{},1000);\n`, { mode: 0o755 });
  const previousPath = process.env.PATH; process.env.PATH = bin + ":" + previousPath;
  let id: string | undefined;
  const waitFor = async (check: () => Promise<boolean>) => {
    const until = Date.now() + 10000;
    while (!await check()) { if (Date.now() > until) throw new Error("Timed out waiting for test agent"); await Bun.sleep(40); }
  };
  try {
    const { token } = await (await fetch(url + "/api/config")).json() as any;
    const response = await fetch(url + "/api/runs", { method: "POST", headers: { "Content-Type": "application/json", "X-Taskground-Token": token }, body: JSON.stringify({ task: "intent_routing", agent: "codex", executionMode: "headless", sourceMode: "working", recording: { width: 640, height: 360, columns: 80, rows: 20 } }) });
    const body = await response.json() as any; expect(response.status, JSON.stringify(body)).toBe(202); id = body.id;
    server.stop(true);
    await waitFor(async () => (await readRun(id!, root)).status === "running");
    const run = await readRun(id!, root); expect(run.source.snapshot).toBeDefined();
    expect(run.source.mode).toBe("working"); expect(await Bun.file(join(run.source.snapshot!, "src/cli.tsx")).exists()).toBe(true);
    const next = await startDashboard({ port: 0, runsRoot: root, open: false }); servers.push(next);
    expect((await (await fetch(next.url + `/api/runs/${id}`)).json() as any).status).toBe("running");
    const config = await (await fetch(next.url + "/api/config")).json() as any;
    const post = (action: string) => fetch(next.url + `/api/runs/${id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Taskground-Token": config.token }, body: "{}" });
    expect((await post("stop")).status).toBe(200);
    await waitFor(async () => (await readRun(id!, root)).status === "cancelled");
    expect(await readFile(join(run.directory, "recording.jsonl"), "utf8")).toContain('"type":"end"');
    const grade = await (await post("verify")).json() as any;
    expect(grade.grading.status).toBe("failed");
    expect((await fetch(next.url + `/api/runs/${id}/report`)).status).toBe(200);
  } finally {
    process.env.PATH = previousPath;
    if (id) { await stopRun(id, root); await waitFor(async () => ["completed", "cancelled", "failed"].includes((await readRun(id!, root)).status)); }
  }
}, 20000);

test("cancellation also stops a detached preparation hook before launching an agent", async () => {
  const { root, data } = await setup();
  const definitionDir = join(data, "definition"); await mkdir(join(definitionDir, "workspace"), { recursive: true });
  await writeFile(join(definitionDir, "instruction.md"), "Offline cancellation fixture");
  await writeFile(join(definitionDir, "workspace/README.md"), "Offline fixture");
  await writeJSON(join(definitionDir, "task.json"), { schemaVersion: 1, id: "prepare_cancel", title: "Cancel preparation", description: "Offline fixture", setup: [process.execPath, "-e", "require('node:fs').writeFileSync('preparing.marker','ready');setInterval(()=>{},1000)"] });
  const run = await scheduleRun({ task: "prepare_cancel", agent: "codex", headless: true, runsRoot: root, definitionDir });
  const until = Date.now() + 10000;
  try {
    while (!await Bun.file(join(run.workspace, "preparing.marker")).exists()) {
      if (Date.now() > until) throw new Error("Preparation hook did not start"); await Bun.sleep(40);
    }
    expect((await readRun(run.id, root)).status).toBe("preparing");
  } finally { await stopRun(run.id, root); }
  while ((await readRun(run.id, root)).status === "preparing") {
    if (Date.now() > until) throw new Error("Preparation hook did not stop"); await Bun.sleep(40);
  }
  const stopped = await readRun(run.id, root);
  expect(stopped.status).toBe("cancelled"); expect(stopped.agentPid).toBeUndefined();
}, 15000);
