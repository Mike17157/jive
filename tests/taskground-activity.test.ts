import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activityEvent, taskRunView } from "../taskground/app/activity";
import type { RunRecord } from "../taskground/app/runner";
import { Database } from "bun:sqlite";

const scratch: string[] = [];
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }); });
const event = (type: string, seconds: number, data: unknown = {}) => ({ type, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(), data });

async function fixture(agent: RunRecord["agent"] = "jive") {
  const directory = await mkdtemp(join(tmpdir(), "taskground-activity-")); scratch.push(directory);
  const run: RunRecord = {
    schemaVersion: 1, id: "activity", task: "fixture", agent, mode: "terminal", status: "running",
    createdAt: event("", 0).timestamp, startedAt: event("", 1).timestamp,
    directory, workspace: join(directory, "workspace"), definition: join(directory, "definition"),
    source: { directory, revision: "fixture", branch: "main", dirty: false, codeHash: "fixture" },
    extraArgs: [], grading: { status: "ungraded" },
  };
  const session = join(run.workspace, ".jev/sessions/fixture/session.jsonl");
  await mkdir(join(session, ".."), { recursive: true });
  await writeFile(join(directory, "run.json"), JSON.stringify(run));
  return { run, session };
}

test("Jive distinguishes final responses from tool calls and individual graph completion", () => {
  expect(activityEvent("jive", event("graph.finished", 2), "test")).toBeUndefined();
  expect(activityEvent("jive", event("planner.message", 2, { message: { role: "assistant", tool_calls: [{ id: "graph" }] } }), "test")).toBeUndefined();
  expect(activityEvent("jive", event("planner.message", 3, { message: { role: "assistant", content: "Finished" } }), "test")?.status).toBe("completed");
  expect(activityEvent("jive", event("transport.error", 4), "test")?.status).toBe("failed");
});

test("completion freezes task duration, keeps the live process available, and resumes on a follow-up", async () => {
  const { run, session } = await fixture();
  await writeFile(session, [event("planner.request", 2), event("planner.message", 10, { message: { role: "assistant", content: "Done" } })].map(value => JSON.stringify(value)).join("\n") + "\n");
  const view = await taskRunView(run);
  expect(view.status).toBe("completed"); expect(view.processStatus).toBe("running");
  expect(view.elapsedMs).toBe(9000); expect(view.finishedAt).toBe(event("", 10).timestamp);
  expect(JSON.parse(await readFile(join(run.directory, "run.json"), "utf8")).status).toBe("running");
  await appendFile(session, JSON.stringify(event("planner.message", 12, { message: { role: "user", content: "Follow up" } })) + "\n");
  const active = await taskRunView(run);
  expect(active.status).toBe("running"); expect(active.finishedAt).toBeUndefined(); expect(active.elapsedMs).toBeUndefined();
  await appendFile(session, JSON.stringify(event("planner.message", 15, { message: { role: "assistant", content: "Done again" } })) + "\n");
  expect((await taskRunView(run)).elapsedMs).toBe(14000);
});

test("historical terminal closure preserves completion, partial records and stale events cannot complete tasks", async () => {
  const { run, session } = await fixture();
  await writeFile(session, JSON.stringify(event("planner.message", 0, { message: { role: "assistant" } })) + "\n");
  expect((await taskRunView(run)).status).toBe("running");
  const final = JSON.stringify(event("planner.message", 10, { message: { role: "assistant", content: "Done" } }));
  await appendFile(session, final.slice(0, -5));
  expect((await taskRunView(run)).status).toBe("running");
  await appendFile(session, final.slice(-5) + "\n");
  const closed = { ...run, status: "cancelled" as const, finishedAt: event("", 20).timestamp, elapsedMs: 19000 };
  expect(await taskRunView(closed)).toMatchObject({ status: "completed", processStatus: "cancelled", elapsedMs: 9000 });
  await writeFile(session, JSON.stringify(event("planner.request", 12)) + "\n");
  expect((await taskRunView(run)).status).toBe("running");
});

test("headless runs retain process semantics and more work invalidates a prior native verification", async () => {
  const { run, session } = await fixture();
  await writeFile(session, JSON.stringify(event("planner.request", 12)) + "\n");
  const graded = { ...run, grading: { status: "passed" as const, report: "old-report", activityAt: event("", 10).timestamp, attempts: ["old-report"] } };
  expect((await taskRunView(graded)).grading).toEqual({ status: "ungraded", attempts: ["old-report"] });
  expect((await taskRunView({ ...graded, mode: "headless" })).status).toBe("running");
});

test("Codex discovers its exact workspace, excludes child agents, and handles success, retries and cancellation", async () => {
  const { run } = await fixture("codex");
  run.sessionRoot = join(run.directory, "codex-home");
  const directory = join(run.sessionRoot, "sessions/2026/01/01"); await mkdir(directory, { recursive: true });
  const path = join(directory, "rollout.jsonl"), child = join(directory, "child.jsonl"), unrelated = join(directory, "unrelated.jsonl");
  const meta = (cwd: string, source: unknown = "cli") => ({ ...event("session_meta", 1), payload: { cwd, source } });
  const turn = (type: string, seconds: number) => ({ ...event("event_msg", seconds), payload: { type, turn_id: "fixture" } });
  await writeFile(path, [meta(run.workspace), turn("task_started", 2), turn("item_completed", 4)].map(value => JSON.stringify(value)).join("\n") + "\n");
  await writeFile(child, [meta(run.workspace, { subagent: { spawn: {} } }), turn("task_complete", 50)].map(value => JSON.stringify(value)).join("\n") + "\n");
  await writeFile(unrelated, [meta("/another/workspace"), turn("task_complete", 60)].map(value => JSON.stringify(value)).join("\n") + "\n");
  expect((await taskRunView(run)).status).toBe("running");
  await appendFile(path, JSON.stringify(turn("task_complete", 10)) + "\n");
  expect(await taskRunView(run)).toMatchObject({ status: "completed", processStatus: "running", elapsedMs: 9000 });
  await appendFile(path, [turn("task_started", 12), turn("stream_error", 13)].map(value => JSON.stringify(value)).join("\n") + "\n");
  expect((await taskRunView(run)).status).toBe("running");
  await appendFile(path, [turn("error", 14), turn("task_complete", 15)].map(value => JSON.stringify(value)).join("\n") + "\n");
  expect((await taskRunView(run)).status).toBe("failed");
  await appendFile(path, [turn("task_started", 16), turn("turn_aborted", 17), turn("task_complete", 18)].map(value => JSON.stringify(value)).join("\n") + "\n");
  expect((await taskRunView(run)).status).toBe("cancelled");
});

test("Codex can discover rollouts from its read-only SQLite index", async () => {
  const { run } = await fixture("codex");
  run.sessionRoot = join(run.directory, "codex-home"); await mkdir(run.sessionRoot);
  const path = join(run.sessionRoot, "indexed-rollout.jsonl");
  await writeFile(path, [{ ...event("session_meta", 1), payload: { cwd: run.workspace, source: "cli", base_instructions: "x".repeat(80000) } }, { ...event("event_msg", 10), payload: { type: "task_complete" } }].map(value => JSON.stringify(value)).join("\n") + "\n");
  const db = new Database(join(run.sessionRoot, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (cwd TEXT, rollout_path TEXT)");
  db.query("INSERT INTO threads VALUES (?,?)").run(run.workspace, path); db.close();
  expect((await taskRunView(run)).status).toBe("completed");
});

test("Claude waits for the root turn to end, ignores tools/child agents, and preserves errors and interruptions", async () => {
  const { run } = await fixture("claude");
  run.sessionRoot = join(run.directory, "claude-home");
  const directory = join(run.sessionRoot, "projects", run.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(directory, { recursive: true });
  const path = join(directory, "session.jsonl");
  const record = (type: string, seconds: number, extra: object) => ({ ...event(type, seconds), cwd: run.workspace, isSidechain: false, ...extra });
  const append = (...events: object[]) => appendFile(path, events.map(value => JSON.stringify(value)).join("\n") + "\n");
  await append(record("user", 2, { message: { role: "user", content: "Task" } }), record("assistant", 3, { message: { role: "assistant", stop_reason: "end_turn" } }));
  expect((await taskRunView(run)).status).toBe("running");
  await append(record("system", 4, { subtype: "turn_duration", isSidechain: true }), record("system", 50, { subtype: "turn_duration", cwd: "/different/project" }));
  expect((await taskRunView(run)).status).toBe("running");
  await append(record("system", 5, { subtype: "turn_duration" }));
  expect(await taskRunView(run)).toMatchObject({ status: "completed", elapsedMs: 4000, processStatus: "running" });
  await append(record("user", 6, { message: { role: "user", content: "Followup" } }), record("assistant", 7, { isApiErrorMessage: true }), record("system", 8, { subtype: "turn_duration" }));
  expect((await taskRunView(run)).status).toBe("failed");
  await append(record("user", 9, { message: { role: "user", content: "Retry" } }), record("user", 10, { interruptedMessageId: "interrupted", message: { role: "user", content: "" } }), record("system", 11, { subtype: "turn_duration" }));
  expect((await taskRunView(run)).status).toBe("cancelled");
});
