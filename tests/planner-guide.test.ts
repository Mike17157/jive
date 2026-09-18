import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGraph } from "../src/core/executor.ts";
import type { JevAdapter } from "../src/core/types.ts";
import { CRAWL_EXAMPLE, GRAPH_GUIDE, PLANNING_GUIDE, REFERENCE_EXAMPLE } from "../src/core/planner-guide.ts";
import { validateGraph } from "../src/core/schema.ts";
import { PLANNER_SYSTEM_PROMPT } from "../src/planner/agent.ts";

describe("planner guide", () => {
  test("reference examples validate against the graph schema", () => {
    expect(() => validateGraph(structuredClone(REFERENCE_EXAMPLE))).not.toThrow();
    expect(() => validateGraph(structuredClone(CRAWL_EXAMPLE))).not.toThrow();
  });

  test("the crawl example demonstrates a loop with per-item Jev decisions", () => {
    const crawl = CRAWL_EXAMPLE.groups.crawl;
    expect(crawl.kind).toBe("repeat");
    expect(CRAWL_EXAMPLE.templates.round.groups.expand.kind).toBe("foreach");
    expect(CRAWL_EXAMPLE.templates.expand.nodes.pick.type).toBe("jev");
    expect(CRAWL_EXAMPLE.returns).toEqual(["summary"]);
  });

  test("the planner prompt carries the planning guidance and both examples", () => {
    expect(GRAPH_GUIDE).toContain(PLANNING_GUIDE);
    expect(GRAPH_GUIDE).toContain(JSON.stringify(REFERENCE_EXAMPLE));
    expect(GRAPH_GUIDE).toContain(JSON.stringify(CRAWL_EXAMPLE));
    expect(PLANNER_SYSTEM_PROMPT).toContain("How to plan with graphs:");
    expect(PLANNER_SYSTEM_PROMPT).toContain("Crawl loop example:");
  });
});

describe("crawl example execution", () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  test("the loop fetches each frontier in parallel, lets Jev pick per item, and stops when the frontier empties", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jive-crawl-"));
    directories.push(directory);
    // Local stand-in for the Wikipedia links API: title -> linked titles.
    await writeFile(join(directory, "links.json"), JSON.stringify({
      Rose: ["Flower", "Rosaceae"], Tulip: ["Flower", "Liliaceae"], Flower: ["Plant", "Rose"], Plant: ["Flower"],
    }));
    const graph = structuredClone(CRAWL_EXAMPLE) as any;
    graph.templates.expand.nodes.links.script =
      `python3 -c 'import json,sys; print("\\n".join(json.load(open("links.json")).get(sys.argv[1],[])))' "$TITLE"`;
    // Jev stand-in: take the first candidate, except on Plant where nothing qualifies.
    const jev: JevAdapter = { async evaluate(request) {
      const options = Object.keys((request.questions as any).next.criteria);
      const choice = (request.state as any).page === "Plant" ? "none" : options[0]!;
      return { model: "fixture", answers: { next: { type: "choice", choice, confidence: 0.9,
        probabilities: Object.fromEntries(options.map((id) => [id, id === choice ? 0.9 : 0.1 / (options.length - 1)])) } } };
    } };
    const report = await executeGraph(graph, { cwd: directory, jev });
    expect(report.status).toBe("done");
    const crawl = report.previews.find((p) => p.id === "crawl");
    expect(crawl?.status).toBe("done");
    const edges = await readFile(join(directory, "crawl", "edges.tsv"), "utf8");
    expect(edges.trim().split("\n").sort()).toEqual(["Flower\tPlant", "Rose\tFlower", "Tulip\tFlower"]);
    const visited = await readFile(join(directory, "crawl", "visited.txt"), "utf8");
    expect(visited.split("\n")).toEqual(["Flower", "Plant", "Rose", "Tulip"]);
    // Three rounds: seeds, then Flower, then Plant (whose "none" answer empties the frontier).
    const iterations = report.previews.filter((p) => /^crawl\[\d+\]\/merge$/.test(p.id));
    expect(iterations.map((p) => p.status)).toEqual(["done", "done", "done"]);
    expect((report.requested.summary?.output as any).stdout).toContain("3 crawl/edges.tsv");
  }, 20000);
});
