import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyGraphEdits,
  loadSavedGraph,
  parseGraphModCall,
  saveGraphForEditing,
} from "../src/core/graph-edits.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const base = {
  version: 1,
  label: "build",
  limits: { timeoutMs: 1000 },
  templates: { expand: { nodes: { links: { type: "bash", script: "curl $URL", env: { URL: { $ref: "/item" } } } } } },
  nodes: {
    build: { type: "bash", script: "npm ci\nnpm test\nnpm run build", env: { CI: "1" } },
    probe: { type: "bash", script: "npm test --version" },
  },
  returns: ["build"],
};

describe("applyGraphEdits", () => {
  test("replaces exactly one substring inside the string at the pointer and keeps the rest of the node", () => {
    const { graph, applied } = applyGraphEdits(base, [{ path: "/nodes/build/script", old: "npm test\n", new: "npm test -- --ci\n" }]);
    const nodes = (graph as typeof base).nodes;
    expect(nodes.build.script).toBe("npm ci\nnpm test -- --ci\nnpm run build");
    expect(nodes.build.env).toEqual({ CI: "1" });
    expect(applied).toEqual(["/nodes/build/script: replaced 9 characters"]);
    // The base is untouched.
    expect(base.nodes.build.script).toBe("npm ci\nnpm test\nnpm run build");
  });

  test("a substring that matches several times or not at all fails with the current value", () => {
    expect(() => applyGraphEdits(base, [{ path: "/nodes/build/script", old: "npm", new: "pnpm" }]))
      .toThrow(/edits\[0\] at \/nodes\/build\/script: old occurs 3 times; include more surrounding text[\s\S]*Current value:\nnpm ci/);
    expect(() => applyGraphEdits(base, [{ path: "/nodes/build/script", old: "yarn", new: "pnpm" }]))
      .toThrow(/old was not found. Current value:\nnpm ci/);
  });

  test("old/new on a non-string explains what was found", () => {
    expect(() => applyGraphEdits(base, [{ path: "/nodes/build", old: "x", new: "y" }]))
      .toThrow(/needs a string at the path, but found \{"type":"bash"/);
    expect(() => applyGraphEdits(base, [{ path: "/nodes/missing/script", old: "x", new: "y" }]))
      .toThrow(/path does not exist \(missing "missing"\)\. Existing keys here: \["build","probe"\]/);
  });

  test("sets whole values, adds nodes, deletes with null, and edits inside templates and arrays", () => {
    const { graph, applied } = applyGraphEdits(base, [
      { path: "/nodes/probe", new: null },
      { path: "/nodes/lint", new: { type: "bash", script: "npm run lint", needs: ["build"] } },
      { path: "/limits/timeoutMs", new: 60000 },
      { path: "/templates/expand/nodes/links/env/URL", new: { $ref: "/input/url" } },
      { path: "/returns/-", new: "lint" },
      { path: "/returns/0", new: "build" },
    ]);
    const edited = graph as any;
    expect(edited.nodes.probe).toBeUndefined();
    expect(edited.nodes.lint).toEqual({ type: "bash", script: "npm run lint", needs: ["build"] });
    expect(edited.limits.timeoutMs).toBe(60000);
    expect(edited.templates.expand.nodes.links.env.URL).toEqual({ $ref: "/input/url" });
    expect(edited.returns).toEqual(["build", "lint"]);
    expect(applied).toEqual([
      "/nodes/probe: deleted",
      "/nodes/lint: added",
      "/limits/timeoutMs: replaced",
      "/templates/expand/nodes/links/env/URL: replaced",
      "/returns/-: added",
      "/returns/0: replaced",
    ]);
  });

  test("edits apply in order, so a later edit sees an earlier one", () => {
    const { graph } = applyGraphEdits(base, [
      { path: "/nodes/build/script", new: "make" },
      { path: "/nodes/build/script", old: "make", new: "make -j4" },
    ]);
    expect((graph as any).nodes.build.script).toBe("make -j4");
  });

  test("rejects root edits, missing deletes, and out-of-range array indices", () => {
    expect(() => applyGraphEdits(base, [{ path: "/", new: {} }])).toThrow("the root cannot be edited");
    expect(() => applyGraphEdits(base, [{ path: "/nodes/nope", new: null }])).toThrow("nothing to delete");
    expect(() => applyGraphEdits(base, [{ path: "/returns/5", new: "x" }])).toThrow("out of range (length 1); use - to append");
  });

  test("unescapes ~1 and ~0 in pointer segments", () => {
    const { graph } = applyGraphEdits({ nodes: { a: { env: { "a/b": "1", "c~d": "2" } } } }, [
      { path: "/nodes/a/env/a~1b", new: "x" },
      { path: "/nodes/a/env/c~0d", new: null },
    ]);
    expect((graph as any).nodes.a.env).toEqual({ "a/b": "x" });
  });
});

describe("parseGraphModCall", () => {
  test("accepts base, optional label, and a list of edits", () => {
    const call = parseGraphModCall(JSON.stringify({ base: "g1", label: "retry", edits: [{ path: "/nodes/a/script", old: "x", new: "y" }, { path: "/nodes/b", new: null }] }));
    expect(call).toEqual({ base: "g1", label: "retry", edits: [{ path: "/nodes/a/script", old: "x", new: "y" }, { path: "/nodes/b", new: null }] });
  });

  test("parses a JSON-encoded edits string, like the graph repairs do", () => {
    const call = parseGraphModCall(JSON.stringify({ base: "g1", edits: JSON.stringify([{ path: "/nodes/a", new: null }]) }));
    expect(call.edits).toEqual([{ path: "/nodes/a", new: null }]);
  });

  test("explains malformed calls", () => {
    expect(() => parseGraphModCall("{")).toThrow("execute_graph_mod arguments are not valid JSON");
    expect(() => parseGraphModCall(JSON.stringify({ edits: [] }))).toThrow("base must be the graphId string");
    expect(() => parseGraphModCall(JSON.stringify({ base: "g", edits: [] }))).toThrow("edits must be a non-empty array");
    expect(() => parseGraphModCall(JSON.stringify({ base: "g", edits: [{ path: "nodes/a", new: 1 }] }))).toThrow("edits[0].path must be a JSON pointer starting with /");
    expect(() => parseGraphModCall(JSON.stringify({ base: "g", edits: [{ path: "/nodes/a" }] }))).toThrow("edits[0] needs new");
    expect(() => parseGraphModCall(JSON.stringify({ base: "g", edits: [{ path: "/nodes/a", old: "x" }] }))).toThrow("edits[0].new must be the replacement string when old is given");
    expect(() => parseGraphModCall(JSON.stringify({ base: "g", edits: [{ path: "/nodes/a", old: "", new: "y" }] }))).toThrow("edits[0].old must not be empty");
  });
});

describe("saved graphs", () => {
  test("round-trips through .jev/runs/<id>/graph.json and confines IDs to one segment", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jev-graph-edits-"));
    temporaryDirectories.push(cwd);
    const path = await saveGraphForEditing(cwd, "planner-call_1", base);
    expect(path).toBe(join(cwd, ".jev", "runs", "planner-call_1", "graph.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(base);
    expect(await loadSavedGraph(cwd, "planner-call_1")).toEqual(base);
    await expect(loadSavedGraph(cwd, "nope")).rejects.toThrow('No saved graph with graphId "nope"');
    await expect(loadSavedGraph(cwd, "../sessions")).rejects.toThrow('Invalid graphId "../sessions"');
    await expect(saveGraphForEditing(cwd, "a/b", base)).rejects.toThrow("Invalid graphId");
  });
});
