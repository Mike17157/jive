import { describe, expect, test } from "bun:test";

import * as examples from "../src/core/planner-examples";
import { CRAWL_EXAMPLE, REFERENCE_EXAMPLE } from "../src/core/planner-guide";
import { GraphStreamParser, type GraphStreamUpdate } from "../src/core/graph-stream";

function feedByCharacter(parser: GraphStreamParser, json: string): GraphStreamUpdate[] {
  const updates: GraphStreamUpdate[] = [];
  for (let index = 0; index < json.length; index += 1) {
    updates.push(...parser.push(json.slice(index, index + 1)));
  }
  return updates;
}

function streamHeader(returns: string[] = []) {
  return {
    version: 1,
    label: "eager graph",
    context: {},
    templates: {},
    limits: {},
    returns,
  };
}

describe("GraphStreamParser", () => {
  test("every planner example can execute as it streams", () => {
    for (const graph of [...Object.values(examples), CRAWL_EXAMPLE, REFERENCE_EXAMPLE]) {
      const parser = new GraphStreamParser();
      const updates = feedByCharacter(parser, JSON.stringify(graph));
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.every(update => update.kind === "commit")).toBe(true);
      expect(parser.finish()).toEqual(graph as any);
    }
  });

  test("handles character splits, escapes, Unicode and quoted braces without false closes", () => {
    const script = 'printf "%s" "}{ \\\\"quoted\\\\" \\\\ path 東京 🚀"';
    const graph = {
      version: 1,
      label: "split 🚀",
      nodes: {
        inspect: { type: "bash", script },
      },
    };
    const json = JSON.stringify(graph);
    const parser = new GraphStreamParser();
    const updates = feedByCharacter(parser, json);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.kind).toBe("commit");
    const node = updates[0]?.graph.nodes.inspect;
    expect(node && "script" in node ? node.script : undefined).toBe(script);
    expect(structuredClone(updates[0]!.graph)).toEqual(updates[0]!.graph);
    expect(parser.finish()).toEqual(graph as any);
  });

  test("omitted settings commit immediately and returns may arrive after nodes", () => {
    const parser = new GraphStreamParser();
    const updates = parser.push('{"version":1,"label":"defaults","nodes":{"a":{"type":"bash","script":"printf a"}}');
    expect(updates.map(update => update.kind)).toEqual(["commit"]);
    expect(updates[0]!.graph.limits).toBeUndefined();
    parser.push(',"returns":["a"]}');
    expect(parser.finish().returns).toEqual(["a"]);
  });

  test("omitted settings cannot be supplied after execution starts", () => {
    for (const field of ["context", "limits", "templates", "output"]) {
      const parser = new GraphStreamParser();
      parser.push('{"version":1,"label":"defaults","nodes":{"a":{"type":"bash","script":"printf a"}}');
      expect(() => parser.push(`,"${field}":{}}`)).toThrow("header is frozen");
    }
  });

  test("never commits an unfinished command", () => {
    const prefix = `${JSON.stringify(streamHeader(["write"])).slice(0, -1)},"nodes":{"write":{"type":"bash","script":"echo unfinished`;
    const parser = new GraphStreamParser();
    expect(feedByCharacter(parser, prefix)).toEqual([]);
    expect(() => parser.finish()).toThrow("truncated JSON");
  });

  test("commits only validated backward-dependent prefixes and filters future returns", () => {
    const graph = {
      ...streamHeader(["first", "second"]),
      output: { $ref: "/nodes/second/output" },
      nodes: {
        first: { type: "bash", script: "printf first" },
        second: { type: "bash", needs: ["first"], script: "printf second" },
      },
    };
    const parser = new GraphStreamParser();
    const updates = feedByCharacter(parser, JSON.stringify(graph));

    expect(updates.map((update) => update.kind)).toEqual(["commit", "commit"]);
    expect(Object.keys(updates[0]!.graph.nodes)).toEqual(["first"]);
    expect(updates[0]!.graph.returns).toEqual(["first"]);
    expect(Object.keys(updates[1]!.graph.nodes)).toEqual(["first", "second"]);
    expect(updates[1]!.graph.returns).toEqual(["first", "second"]);
    expect(parser.finish()).toEqual(graph as any);
  });

  test("supports groups before nodes when templates are frozen in the eager header", () => {
    const graph = {
        version: 1,
      label: "groups first",
      context: {},
      templates: {
        item: { nodes: { show: { type: "bash", script: "printf item" } } },
      },
      limits: {},
      returns: ["batch", "after"],
      groups: {
        batch: { kind: "foreach", items: [], template: "item", maxItems: 1 },
      },
      nodes: {
        after: { type: "bash", needs: ["batch"], script: "printf done" },
      },
    };
    const parser = new GraphStreamParser();
    const updates = parser.push(JSON.stringify(graph));

    expect(updates).toHaveLength(2);
    expect(updates[0]?.kind).toBe("commit");
    expect(updates[0]?.graph.nodes).toEqual({});
    expect(Object.keys(updates[0]?.graph.groups ?? {})).toEqual(["batch"]);
    expect(updates[0]?.graph.returns).toEqual(["batch"]);
    expect(updates[1]?.graph.returns).toEqual(["batch", "after"]);
    expect(parser.finish()).toEqual(graph as any);
  });

  test("rejects duplicate header, node, and nested keys before they can revise effects", () => {
    const duplicateHeader = new GraphStreamParser();
    expect(() => duplicateHeader.push('{"version":1,"version":1'))
      .toThrow("Duplicate key");

    const header = JSON.stringify(streamHeader([])).slice(0, -1);
    const duplicateNode = new GraphStreamParser();
    const first = `${header},"nodes":{"same":{"type":"bash","script":"first"},`;
    expect(duplicateNode.push(first)).toHaveLength(1);
    expect(() => duplicateNode.push('"same":{"type":"bash","script":"second"}}}'))
      .toThrow('Duplicate key "same"');

    const duplicateNested = new GraphStreamParser();
    expect(() => duplicateNested.push('{"version":1,"label":"x","nodes":{"a":{"type":"bash","script":"one","script":"two"}}}'))
      .toThrow('Duplicate key "script"');
  });

  test("names an unlabelled graph after its first node and tolerates a missing version", () => {
    const unnamed = new GraphStreamParser();
    const updates = unnamed.push('{"nodes":{"read":{"type":"bash","script":"cat package.json\\nwc -l"}}}');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.graph).toMatchObject({ version: 1, label: "cat package.json" });
    expect(unnamed.finish()).toMatchObject({ version: 1, label: "cat package.json" });
    expect(unnamed.repairs).toContain("/version: missing; assumed the only contract version, 1");
    expect(unnamed.repairs).toContain('/label: missing; named the graph "cat package.json" after its first node');

    const labelled = new GraphStreamParser();
    labelled.push('{"version":1,"label":"","nodes":{"read":{"type":"bash","label":"Read manifest","script":"cat package.json"}}}');
    expect(labelled.finish().label).toBe("Read manifest");

    const late = new GraphStreamParser();
    late.push('{"version":1,"nodes":{"a":{"type":"bash","script":"true"}},"label":"Named at the end"}');
    expect(late.finish().label).toBe("Named at the end");
  });

  test("freezes settings once work starts", () => {

    const late = new GraphStreamParser();
    const prefix = `${JSON.stringify(streamHeader([])).slice(0, -1)},"nodes":{},`;
    expect(late.push(prefix)).toEqual([]);
    expect(() => late.push('"output":null}')).toThrow("header is frozen");

    for (const eager of [true, false]) {
      const removedOption = new GraphStreamParser();
      expect(() => removedOption.push(JSON.stringify({ version: 1, label: "x", eager, nodes: {} })))
        .toThrow('unknown property "eager"');
    }

    const invalidHeader = new GraphStreamParser();
    const withUnknown = `${JSON.stringify({ ...streamHeader([]), unknown: true }).slice(0, -1)},"nodes":{"a":{"type":"bash","script":"never"}}}`;
    expect(() => invalidHeader.push(withUnknown)).toThrow("Invalid graph");
  });

  test("adopts definitions written past a prematurely closed nodes or groups map", () => {
    const header = JSON.stringify({
      ...streamHeader(["collect", "classify", "merge"]),
      templates: { round: { nodes: { fetch: { type: "bash", script: "printf hi" } } } },
    }).slice(0, -1);
    const parser = new GraphStreamParser();
    const updates = feedByCharacter(parser, `${header},"nodes":{"collect":{"type":"bash","script":"printf collect"}}`
      + ',"groups":{"classify":{"kind":"foreach","items":[],"template":"round","maxItems":1}}'
      + ',"merge":{"type":"bash","needs":["classify"],"script":"printf merge"}'
      + ',"later":{"kind":"repeat","template":"round","initial":{},"next":{},"until":{"op":"exists","args":[1]},"maxIterations":1}}');

    expect(updates.map((update) => update.kind)).toEqual(["commit", "commit", "commit", "commit"]);
    const last = updates.at(-1)!.graph;
    expect(Object.keys(last.nodes)).toEqual(["collect", "merge"]);
    expect(Object.keys(last.groups ?? {})).toEqual(["classify", "later"]);
    expect(last.returns).toEqual(["collect", "classify", "merge"]);
    expect((last as unknown as Record<string, unknown>).merge).toBeUndefined();
    expect(parser.finish()).toEqual(last as any);
    expect(parser.repairs).toEqual([
      "/merge: moved into /nodes; the nodes map was closed before this definition",
      "/later: moved into /groups; the groups map was closed before this definition",
    ]);

    const duplicate = new GraphStreamParser();
    duplicate.push(`${header},"nodes":{"collect":{"type":"bash","script":"printf collect"}}`);
    expect(() => duplicate.push(',"collect":{"type":"bash","script":"printf again"}}'))
      .toThrow('Duplicate nodes entry "collect"');
  });

  test("preview-only hosts allow forward references and streaming commits wait for them", () => {
    const normalGraph = {
      version: 1,
      label: "normal forward reference",
      nodes: {
        first: { type: "bash", needs: ["later"], script: "printf first" },
        later: { type: "bash", script: "printf later" },
      },
    };
    const normal = new GraphStreamParser(false);
    const previews = normal.push(JSON.stringify(normalGraph));
    expect(previews).toHaveLength(2);
    expect(previews[0]?.kind).toBe("preview");
    expect(normal.finish()).toEqual(normalGraph as any);

    const eagerGraph = { ...streamHeader(["first", "later"]), nodes: normalGraph.nodes };
    const eager = new GraphStreamParser();
    const updates = feedByCharacter(eager, JSON.stringify(eagerGraph));
    expect(updates.map(update => update.kind)).toEqual(["commit", "commit"]);
    expect(Object.keys(updates[0]!.graph.nodes)).toEqual(["later"]);
    expect(updates[0]!.graph.returns).toEqual(["later"]);
    expect(Object.keys(updates[1]!.graph.nodes).sort()).toEqual(["first", "later"]);
    expect(updates[1]!.graph.returns).toEqual(["first", "later"]);
    expect(eager.finish()).toEqual(eagerGraph as any);
  });

  test("a waiting entry commits as soon as its last dependency does, through references and groups", () => {
    const graph = {
      ...streamHeader(["merge"]),
      templates: { item: { nodes: { show: { type: "bash", script: "printf item" } } } },
      nodes: {
        merge: { type: "bash", stdin: { ref: "/groups/batch/output/items" }, needs: ["load"], script: "cat" },
        load: { type: "bash", script: "printf '[]'", outputFormat: "json" },
        unrelated: { type: "bash", script: "printf free" },
      },
      groups: {
        batch: { kind: "foreach", items: { $ref: "/nodes/load/output/json" }, template: "item", maxItems: 5 },
      },
    };
    const parser = new GraphStreamParser();
    const updates = feedByCharacter(parser, JSON.stringify(graph));
    const committed = updates.map(update => [...Object.keys(update.graph.nodes), ...Object.keys(update.graph.groups ?? {})]);
    // merge waits for load and for the batch group its ref alias names; unrelated work is not held back.
    expect(committed).toEqual([["load"], ["load", "unrelated"], ["load", "unrelated", "batch"], ["merge", "load", "unrelated", "batch"]]);
    expect(parser.finish().nodes.merge).toMatchObject({ stdin: { $ref: "/groups/batch/output/items" } });
  });

  test("an unnamed graph keeps the name of its first node while that node waits", () => {
    const graph = {
      version: 1,
      nodes: {
        report: { type: "bash", needs: ["summarize"], script: "printf report" },
        summarize: { type: "bash", script: "printf summary" },
      },
    };
    const parser = new GraphStreamParser();
    const updates = parser.push(JSON.stringify(graph));
    expect(updates.map(update => update.graph.label)).toEqual(["printf report", "printf report"]);
    expect(parser.finish().label).toBe("printf report");
  });

  test("an entry whose dependency never arrives fails the final validation, not the stream", () => {
    const parser = new GraphStreamParser();
    const updates = parser.push(`${JSON.stringify(streamHeader([])).slice(0, -1)},"nodes":{"a":{"type":"bash","needs":["missing"],"script":"never"},"b":{"type":"bash","script":"printf b"}}}`);
    expect(updates.map(update => Object.keys(update.graph.nodes))).toEqual([["b"]]);
    expect(() => parser.finish()).toThrow("Unknown dependency missing");

    const cycle = new GraphStreamParser();
    expect(cycle.push('{"version":1,"label":"x","nodes":{"a":{"type":"bash","needs":["b"],"script":"a"},"b":{"type":"bash","needs":["a"],"script":"b"}}}')).toEqual([]);
    expect(() => cycle.finish()).toThrow("Dependency cycle");
  });

  test("a malformed entry is rejected as soon as it closes, even with unmet dependencies", () => {
    const parser = new GraphStreamParser();
    expect(() => parser.push('{"version":1,"label":"x","nodes":{"a":{"type":"bash","needs":"later","script":"a"}')).toThrow("Invalid graph");
  });

  test("an optional field sent as null commits without it", () => {
    const parser = new GraphStreamParser();
    const updates = parser.push('{"version":1,"label":"x","nodes":{"a":{"type":"bash","script":"printf a"},"b":{"when":null,"type":"bash","needs":["a"],"script":"printf b"}}}');
    expect(updates.map(update => update.kind)).toEqual(["commit", "commit"]);
    expect(updates[1]!.graph.nodes.b).toEqual({ type: "bash", needs: ["a"], script: "printf b" });
    expect(parser.finish().nodes.b).toEqual({ type: "bash", needs: ["a"], script: "printf b" });
    expect(parser.repairs).toEqual(["/nodes/b/when: dropped null; leave out optional fields that are not set"]);
  });

  test("repairs a string version in both eager commits and the final graph, and remembers what it changed", () => {
    const eager = new GraphStreamParser();
    const header = JSON.stringify({ ...streamHeader(["a"]), version: "1" }).slice(0, -1);
    const updates = eager.push(`${header},"nodes":{"a":{"type":"bash","script":"printf a"}}}`);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.kind).toBe("commit");
    expect(updates[0]?.graph.version).toBe(1);
    expect(eager.finish().version).toBe(1);
    expect(eager.repairs).toEqual(['/version: coerced the string "1" to the number 1']);

    const normal = new GraphStreamParser(false);
    normal.push(JSON.stringify({ version: "1", label: "x", nodes: JSON.stringify({ a: { type: "bash", script: "ls" } }) }));
    expect(normal.finish()).toEqual({ version: 1, label: "x", nodes: { a: { type: "bash", script: "ls" } } } as any);
    expect(normal.repairs).toHaveLength(2);

    const clean = new GraphStreamParser();
    clean.push('{"version":1,"label":"x","nodes":{}}');
    clean.finish();
    expect(clean.repairs).toEqual([]);
  });

  test("rejects malformed, schema-invalid, and truncated final input", () => {
    const malformed = new GraphStreamParser();
    expect(() => malformed.push('{"version":1,,')).toThrow("Unexpected comma");
    const badNumber = new GraphStreamParser();
    expect(() => badNumber.push('{"version":01')).toThrow("Invalid number character");

    const invalid = new GraphStreamParser();
    expect(() => invalid.push('{"version":1,"label":"invalid","nodes":{"bad":{"type":"bash"}}}'))
      .toThrow("Invalid graph");

    const truncated = new GraphStreamParser();
    truncated.push('{"version":1,"label":"cut","nodes":{}');
    expect(() => truncated.finish()).toThrow("truncated JSON");
  });
});
