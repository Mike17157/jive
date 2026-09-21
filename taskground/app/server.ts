import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { listTasks, writeJSON } from "./tasks";
import { dataDirectory, defaultRunsRoot, listRuns, locateRun } from "./storage";
import { primarySource, type SourceMode } from "./source";
import { scheduleRun, stopRun, verifyRun, type RunRecord } from "./runner";
import { getRunMetrics } from "./metrics";
import { readRunOutput } from "./output";
import { exportRecording, validateRecording } from "./recording";
import { AGENTS, type Agent } from "./agents";
import { getAgentModels, validateModelSelection } from "./models";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const stopped = new Set(["completed", "failed", "cancelled", "timed_out", "ready"]);

async function describe(run: RunRecord) {
  const { id, task, agent, mode, status, grading, createdAt, startedAt, finishedAt, elapsedMs, source, recording, workspace, directory, error, model, effort } = run;
  const exportState = await Bun.file(join(run.directory, "recording.mp4")).exists() ? { status: "ready" } : await readFile(join(run.directory, "export.json"), "utf8").then(JSON.parse).catch(() => undefined);
  if (exportState?.status === "exporting" && exportState.pid) {
    try { process.kill(exportState.pid, 0); } catch { exportState.status = "error"; exportState.error = "Export was interrupted. Export again to retry."; }
  }
  return { id, task, agent, model, effort, mode, status, grading, createdAt, startedAt, finishedAt, elapsedMs, source, recording, workspace, directory, error, metrics: await getRunMetrics(run), export: exportState };
}

export async function startDashboard(options: { port?: number; runsRoot?: string; open?: boolean } = {}) {
  const token = randomBytes(32).toString("hex");
  const root = options.runsRoot ?? await defaultRunsRoot();
  const pendingExports = new Set<string>();
  const pendingVerifiers = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: options.port ?? 4317,
    idleTimeout: 255, maxRequestBodySize: 16384,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (request.headers.get("host") !== `127.0.0.1:${server.port}`) return json({ error: "Invalid dashboard host" }, 403);
        const origin = request.headers.get("origin");
        if (origin && origin !== `http://127.0.0.1:${server.port}` || request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Cross-origin request denied" }, 403);
        if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
        if (request.method === "POST") {
          const supplied = Buffer.from(request.headers.get("x-taskground-token") ?? "");
          if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) return json({ error: "Invalid dashboard token; refresh the page" }, 403);
          if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "Expected application/json" }, 415);
        }
        if (url.pathname === "/api/config" && request.method === "GET") return json({ token });
        if (url.pathname === "/api/models" && request.method === "GET") {
          const agent = url.searchParams.get("agent") as Agent;
          if (!AGENTS.includes(agent)) throw new Error("Choose a valid agent");
          return json(await getAgentModels(agent));
        }
        if (url.pathname === "/api/state" && request.method === "GET") {
          const source = await primarySource();
          const [tasks, runs] = await Promise.all([listTasks(join(source.directory, "taskground/task_definitions")), listRuns(root)]);
          return json({ tasks, runs: await Promise.all(runs.map(describe)), source, dataDirectory: await dataDirectory() });
        }
        if (url.pathname === "/api/runs" && request.method === "POST") {
          const body = await request.json() as Record<string, unknown>;
          if (typeof body.task !== "string" || !AGENTS.includes(body.agent as Agent)) throw new Error("Choose a task and agent");
          const sourceMode = body.sourceMode ?? "working";
          if (!["working", "head", "commit"].includes(String(sourceMode))) throw new Error("Invalid source selection");
          if (body.model !== undefined && typeof body.model !== "string" || body.commit !== undefined && typeof body.commit !== "string") throw new Error("Model and commit must be text");
          if (body.timeoutSeconds !== undefined && typeof body.timeoutSeconds !== "number") throw new Error("Timeout must be a number");
          if (body.effort !== undefined && typeof body.effort !== "string") throw new Error("Thinking effort must be text");
          if (body.model || body.effort) validateModelSelection(await getAgentModels(body.agent as Agent), body.model as string | undefined, body.effort as string | undefined);
          const run = await scheduleRun({ task: body.task, agent: body.agent as Agent, model: body.model as string | undefined, effort: body.effort as string | undefined, headless: true, runsRoot: root, sourceMode: sourceMode as SourceMode, commit: body.commit as string | undefined, timeoutSeconds: body.timeoutSeconds as number | undefined, recording: body.recording ? validateRecording(body.recording) : undefined });
          return json({ id: run.id }, 202);
        }
        const match = /^\/api\/runs\/([A-Za-z0-9_-]+)(?:\/(output|stop|verify|export|recording|artifacts|artifact|report))?$/.exec(url.pathname);
        if (match) {
          const { run, root: runRoot } = await locateRun(match[1]!, root);
          if (run.mode !== "headless") return json({ error: "Interactive runs are not tracked by the dashboard" }, 404);
          const action = match[2];
          if (request.method === "POST") {
            if (action === "stop") return json(await describe(await stopRun(run.id, runRoot)));
            if (action === "verify") {
              if (pendingVerifiers.has(run.id)) return json({ error: "Verification is already running" }, 409);
              pendingVerifiers.add(run.id);
              try { return json(await describe(await verifyRun(run.id, runRoot))); } finally { pendingVerifiers.delete(run.id); }
            }
            if (action === "export") {
              if (!run.recording) throw new Error("Recording was not enabled for this run");
              if (!stopped.has(run.status)) throw new Error("Wait for the run to stop before exporting");
              if (pendingExports.has(run.id)) return json({ status: "exporting" }, 202);
              pendingExports.add(run.id);
              const stateFile = join(run.directory, "export.json");
              await writeJSON(stateFile, { status: "exporting", pid: process.pid });
              void exportRecording(run).then(
                () => writeJSON(stateFile, { status: "ready" }),
                error => writeJSON(stateFile, { status: "error", error: error instanceof Error ? error.message : String(error) }),
              ).finally(() => pendingExports.delete(run.id));
              return json({ status: "exporting" }, 202);
            }
            return json({ error: "Unknown action" }, 404);
          }
          if (!action) return json(await describe(run));
          if (action === "output") return json({ text: await readRunOutput(run) });
          if (action === "report") return run.grading.report ? json(JSON.parse(await readFile(run.grading.report, "utf8"))) : json({ error: "No verification report yet" }, 404);
          if (action === "recording") {
            const file = Bun.file(join(run.directory, "recording.mp4"));
            return await file.exists() ? new Response(file, { headers: { "Content-Type": "video/mp4", "Content-Disposition": `attachment; filename="${run.id}.mp4"` } }) : json({ error: "Export the recording first" }, 404);
          }
          if (action === "artifacts" || action === "artifact") {
            const work = await realpath(join(run.workspace, "work"));
            if (action === "artifact") {
              const path = await realpath(resolve(work, url.searchParams.get("path") ?? ""));
              if (!path.startsWith(work + sep) || !(await stat(path)).isFile()) return json({ error: "Invalid artifact" }, 403);
              return new Response(Bun.file(path), { headers: { "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff" } });
            }
            const files: { path: string; bytes: number }[] = [];
            const walk = async (dir: string, prefix = "", depth = 0) => {
              if (depth > 5 || files.length >= 500) return;
              for (const file of await readdir(dir, { withFileTypes: true })) {
                if (files.length >= 500) break;
                if (file.isDirectory()) await walk(join(dir, file.name), prefix + file.name + "/", depth + 1);
                else if (file.isFile()) files.push({ path: prefix + file.name, bytes: (await stat(join(dir, file.name))).size });
              }
            };
            await walk(work); return json({ files });
          }
          return json({ error: "Unknown action" }, 404);
        }
        if (request.method === "GET" && ["/", "/app.js", "/style.css"].includes(url.pathname)) {
          const file = Bun.file(join(import.meta.dir, "web", url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
          return new Response(file, { headers: { "Cache-Control": "no-cache", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'", "X-Content-Type-Options": "nosniff" } });
        }
        return json({ error: "Not found" }, 404);
      } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  if (options.open !== false) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", () => console.error(`Open ${url} in your browser`)); child.unref();
  }
  return { server, url };
}
