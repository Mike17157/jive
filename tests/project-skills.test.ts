import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadProjectSkills } from "../src/core/project-skills.ts";
import { executeGraph } from "../src/core/executor.ts";
import { GraphAgentController, type AgentOptions } from "../src/planner/agent.ts";
import { DeterministicContext, SessionStore } from "../src/session/index.ts";

const directories: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "jive-skills-"));
  directories.push(cwd);
  return cwd;
}

async function skillFile(cwd: string, folder: string, text: string) {
  const path = join(cwd, ".jive", "skills", folder, "SKILL.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

function skill(name: string, description: string, body = "Read graph.json and adapt it freely.") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

function response(name?: string, args?: unknown) {
  const delta = name
    ? { tool_calls: [{ index: 0, id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }] }
    : { content: "Done." };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function captureRequests(reply: (body: any, index: number) => Response = () => response()) {
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return reply(body, bodies.length - 1);
  }) as typeof fetch;
  return bodies;
}

function options(cwd: string, sessionId = "skills-session"): AgentOptions {
  return {
    cwd, sessionId, model: "test/model", apiKey: "test-key",
    toolSchema: { name: "execute_graph", parameters: { type: "object" } },
    getPluginCatalog: async () => "",
    execute: (graph, signal, onEvent) => executeGraph(graph, { cwd, signal, onEvent, trackFileChanges: false }),
  };
}

describe("project skill discovery", () => {
  test("a missing folder gives an empty catalog without creating project files", async () => {
    const cwd = await workspace();
    expect(await loadProjectSkills(cwd)).toEqual({ directory: join(cwd, ".jive", "skills"), skills: [], diagnostics: [] });
    await expect(readFile(join(cwd, ".jive"))).rejects.toThrow();
  });

  test("reads YAML metadata in stable folder order, supports multiline text, and leaves bodies and graphs unloaded", async () => {
    const cwd = await workspace();
    const later = await skillFile(cwd, "z-last", '\uFEFF---\r\nname: "last"\r\ndescription: |\r\n  Last description:\r\n  use for later tasks.\r\nextra: ignored\r\n---\r\nPRIVATE BODY');
    const earlier = await skillFile(cwd, "a-first", '---\nname: first\ndescription: >-\n  First description\n  spans lines.\n---\nBODY ALSO OMITTED');
    await writeFile(join(dirname(earlier), "graph.json"), "deliberately invalid graph; discovery must not parse this");
    await skillFile(cwd, "support/nested", skill("nested", "Do not discover recursively."));
    await writeFile(join(cwd, ".jive", "skills", "notes.txt"), "not a skill");
    const snapshot = await loadProjectSkills(cwd);
    expect(snapshot).toEqual({ directory: join(cwd, ".jive", "skills"), diagnostics: [], skills: [
      { name: "first", description: "First description spans lines.", path: earlier },
      { name: "last", description: "Last description: use for later tasks.", path: later },
    ] });
  });

  test.each([
    ["missing header", "name: bad\ndescription: description"],
    ["unclosed header", "---\nname: bad\ndescription: description"],
    ["header only later in body", "Body first\n---\nname: bad\ndescription: description\n---"],
    ["non-mapping", "---\n- bad\n---"],
    ["invalid YAML", "---\nname: [\ndescription: broken\n---"],
    ["missing name", "---\ndescription: description\n---"],
    ["missing description", "---\nname: bad\n---"],
    ["empty description", '---\nname: bad\ndescription: " "\n---'],
    ["non-string description", "---\nname: bad\ndescription: false\n---"],
    ["multiline name", "---\nname: |\n  bad\n  name\ndescription: description\n---"],
  ])("skips %s with a diagnostic while retaining valid skills", async (_label, text) => {
    const cwd = await workspace();
    const invalid = await skillFile(cwd, "bad", text);
    await skillFile(cwd, "good", skill("good", "A valid skill."));
    const snapshot = await loadProjectSkills(cwd);
    expect(snapshot.skills.map(skill => skill.name)).toEqual(["good"]);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]).toContain(invalid);
  });

  test("duplicate names keep the first folder and report the conflicting path", async () => {
    const cwd = await workspace();
    const second = await skillFile(cwd, "b", skill("same", "Second."));
    const first = await skillFile(cwd, "a", skill("same", "First."));
    const snapshot = await loadProjectSkills(cwd);
    expect(snapshot.skills).toEqual([{ name: "same", description: "First.", path: first }]);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]).toContain("Duplicate skill name");
    expect(snapshot.diagnostics[0]).toContain(second);
  });

  test("supports linked skill directories and reports filesystem discovery errors", async () => {
    const cwd = await workspace();
    const source = await workspace();
    const sourceFile = await skillFile(source, "shared", skill("shared", "Linked instructions."));
    await mkdir(join(cwd, ".jive", "skills"), { recursive: true });
    await symlink(dirname(sourceFile), join(cwd, ".jive", "skills", "linked"));
    expect((await loadProjectSkills(cwd)).skills[0]).toMatchObject({ name: "shared", path: join(cwd, ".jive", "skills", "linked", "SKILL.md") });
    await rm(join(cwd, ".jive", "skills"), { recursive: true });
    await writeFile(join(cwd, ".jive", "skills"), "not a directory");
    const snapshot = await loadProjectSkills(cwd);
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.diagnostics[0]).toContain("Could not discover project skills");
  });
});

describe("project skill sessions", () => {
  test("catalog stays fixed through turns, compaction, restart and session switching; new sessions rescan", async () => {
    const cwd = await workspace();
    const path = await skillFile(cwd, "original", skill("original", "Original catalog description.", "BODY MUST STAY ON DISK"));
    const bodies = captureRequests();
    const controller = new GraphAgentController(options(cwd));
    await controller.ready();
    expect(controller.store.projectSkills()?.skills).toHaveLength(1);
    expect(await readFile(controller.store.logPath, "utf8")).not.toContain("BODY MUST STAY ON DISK");
    await writeFile(path, skill("original", "Changed catalog description."));
    await skillFile(cwd, "added", skill("added", "Added after startup."));
    await controller.submit("first");
    await controller.submit("second");
    const prefix = bodies[0].messages[0];
    expect(prefix.content).toContain("original: Original catalog description.");
    expect(prefix.content).toContain(path);
    expect(prefix.content).not.toContain("Changed catalog description.");
    expect(prefix.content).not.toContain("Added after startup.");
    expect(prefix.content).not.toContain("BODY MUST STAY ON DISK");
    expect(bodies[1].messages[0]).toEqual(prefix);

    for (let index = 0; index < 20; index++) {
      await controller.store.appendMessage({ role: "assistant", content: "Old evidence. ".repeat(1200) });
    }
    const compacted = await new DeterministicContext(controller.store, [prefix], {
      contextLimit: 30_000, outputReserve: 1000, toolResultReserve: 1000, retentionRatio: 0.1,
    }).prepare();
    expect(compacted.compacted).toBe(true);
    expect(compacted.messages[0]).toEqual(prefix);
    await controller.submit("after compaction");
    expect(bodies[2].messages[0]).toEqual(prefix);
    expect(controller.store.events.filter(event => event.type === "planner.context")).toHaveLength(1);

    await rm(dirname(path), { recursive: true });
    const resumed = new GraphAgentController(options(cwd));
    await resumed.ready();
    await resumed.submit("after restart");
    expect(bodies[3].messages[0]).toEqual(prefix);
    expect(resumed.store.events.filter(event => event.type === "project.skills")).toHaveLength(1);

    await resumed.newSession();
    await resumed.submit("new session");
    expect(bodies[4].messages[0].content).toContain("added: Added after startup.");
    expect(bodies[4].messages[0].content).not.toContain("Original catalog description.");
    await resumed.resumeSession("skills-session");
    await resumed.submit("switch back");
    expect(bodies[5].messages[0]).toEqual(prefix);
    expect(resumed.getSnapshot().error).toBeUndefined();
  });

  test("an empty catalog remains empty on resume even if skills have since been added", async () => {
    const cwd = await workspace();
    const bodies = captureRequests();
    const controller = new GraphAgentController(options(cwd));
    await controller.ready();
    expect(controller.store.projectSkills()?.skills).toEqual([]);
    await skillFile(cwd, "new", skill("new", "Only for new sessions."));
    await controller.submit("same session");
    const resumed = new GraphAgentController(options(cwd));
    await resumed.ready();
    await resumed.submit("resumed session");
    expect(bodies[1].messages[0]).toEqual(bodies[0].messages[0]);
    expect(bodies[1].messages[0].content).not.toContain("Only for new sessions.");
    await resumed.newSession();
    await resumed.submit("fresh session");
    expect(bodies[2].messages[0].content).toContain("Only for new sessions.");
  });

  test("older sessions get a persisted empty catalog rather than discovering new skills on resume", async () => {
    const cwd = await workspace();
    const store = new SessionStore({ cwd, sessionId: "legacy" });
    await store.initialize();
    await store.appendMessage({ role: "user", content: "Earlier task" });
    await skillFile(cwd, "new", skill("new", "Added after the old session."));
    const controller = new GraphAgentController(options(cwd, "legacy"));
    await controller.ready();
    expect(controller.store.projectSkills()?.skills).toEqual([]);
    expect(controller.store.events.filter(event => event.type === "project.skills")).toHaveLength(1);
    await controller.newSession();
    expect(controller.store.projectSkills()?.skills.map(skill => skill.name)).toEqual(["new"]);
  });

  test("discovery diagnostics remain visible on startup, resume, and new sessions without blocking valid skills", async () => {
    const cwd = await workspace();
    await skillFile(cwd, "bad", "missing metadata");
    await skillFile(cwd, "good", skill("good", "Valid."));
    const controller = new GraphAgentController(options(cwd));
    await controller.ready();
    expect(controller.getSnapshot().error).toBeUndefined();
    expect(controller.getSnapshot().messages.filter(message => message.role === "notice")).toHaveLength(1);
    expect(controller.getSnapshot().messages[0]?.text).toContain("Skipped project skill");
    const resumed = new GraphAgentController(options(cwd));
    await resumed.ready();
    expect(resumed.store.events.filter(event => event.type === "notice")).toHaveLength(1);
    await resumed.newSession();
    expect(resumed.getSnapshot().messages[0]?.text).toContain("Skipped project skill");
    expect(resumed.store.projectSkills()?.skills.map(skill => skill.name)).toEqual(["good"]);
  });

  test("the agent reads live skill instructions and freely edits and executes a skill graph using existing tools", async () => {
    const cwd = await workspace();
    const path = await skillFile(cwd, "example", skill("example", "Adapt a graph.", "Old instructions."));
    const graphPath = join(dirname(path), "graph.json");
    const graph = { version: 1, label: "Example", nodes: { original: { type: "bash", script: "printf original" } }, returns: ["original"] };
    await writeFile(graphPath, JSON.stringify(graph));
    const bodies = captureRequests((body, index) => {
      if (index === 0) return response("execute_graph", {
        version: 1, label: "Read skill", nodes: { read: { type: "bash", env: { SKILL: path }, script: 'cat "$SKILL"' } }, returns: ["read"],
      });
      if (index === 1) return response("execute_graph_mod", {
        file: graphPath,
        edits: [
          { path: "/nodes/original", new: null },
          { path: "/nodes/adapted", new: { type: "bash", script: "printf adapted" } },
          { path: "/returns", new: ["adapted"] },
        ],
      });
      return response();
    });
    const controller = new GraphAgentController(options(cwd));
    await controller.ready();
    await writeFile(path, skill("example", "Adapt a graph.", "Current instructions: replace the original node."));
    await controller.submit("Use the example skill with the needed changes.");
    expect(controller.getSnapshot().error).toBeUndefined();
    expect(bodies).toHaveLength(3);
    const read = JSON.parse(bodies[1].messages.findLast((message: any) => message.role === "tool").content);
    expect(read.requested.read.output.stdout).toContain("Current instructions: replace the original node.");
    const run = JSON.parse(bodies[2].messages.findLast((message: any) => message.role === "tool").content);
    expect(run.status).toBe("done");
    expect(run.requested.adapted.output.stdout).toBe("adapted");
    expect(JSON.parse(await readFile(graphPath, "utf8"))).toEqual(graph);
    expect(bodies[0].tools.map((tool: any) => tool.function.name)).toEqual(["execute_graph", "execute_graph_mod"]);
  });
});
